# @ising-tech/isingq-mcp

Standard stdio MCP service for IsingQ public knowledge, QUBO modeling guidance and validation, and cloud or private-network local solving.

[简体中文](README.md) · English

This guide covers **0.9.x**. Install only versions actually published on npm or GitHub Releases.

## Quick start

If you are unfamiliar with terminals or MCP configuration, send this prompt to your current Agent:

```text
Read skills/install-isingq-mcp/SKILL.md from
https://github.com/ising-tech/isingq-toolkit and follow its instructions
to install IsingQ MCP only into the current Agent.
Never ask for or display my API Key in chat. Use the private system prompt if cloud setup is needed;
local-only solving does not require a cloud Key.
Reconnect isingq after installation. If dynamic reload is unavailable, ask me to restart,
then verify the loaded version and its corresponding MCP tools.
```

The installation guide selects one integration for your current Agent and operating system. It does not modify other Agents on your computer. If automatic registration is unavailable, it provides stdio configuration for manual import.

### Manual setup

Supports stdio MCP Hosts such as WorkBuddy, Claude Code, Cursor, and VS Code. The npx setup below requires Node.js **18.17+** and npm.

For a Host using the `mcpServers` format, save this configuration in its MCP settings and reconnect:

```json
{
  "mcpServers": {
    "isingq": {
      "command": "npx",
      "args": ["-y", "@ising-tech/isingq-mcp", "serve"]
    }
  }
}
```

Alternatively, run this command and use the `mcpServers` settings from its output:

```bash
npx @ising-tech/isingq-mcp config --json --npx
```

After reconnecting, verify the loaded version and the four tools below. Restart only if your Host cannot reload dynamically.

## Basic use

Describe your problem to the Agent, for example:

```text
Split A, B, C into two groups to maximize crossing edge weight: AB=3, AC=2, BC=1, with no group-size constraint.
Show the variables, objective, constraints, and matrix summary first. At solve confirmation, let me choose a cloud or local device and wait for my approval.
```

- **Cloud**: choose a public model. For actual submission, create a personal API Key in the [cloud console](https://console.isingq.com/api-keys), configure it through the private prompt, and explicitly choose a compute voucher or account balance.
- **Local**: ask to add/manage local solvers, enter a connection name and service address, and test the connection. Multiple devices are supported without a cloud API Key, voucher, or account balance.

Modeling and validation need no cloud credentials. Saving a device connection does not submit a task. Explicitly confirm each submission; call records retain the original target's actual viewing location. Keep API Keys out of chat, MCP JSON, and logs.

## Default tools

| Tool | Purpose |
| --- | --- |
| `isingq_api_key_setup` | Configure the cloud API Key through a private prompt |
| `isingq_knowledge_get` | Query local public knowledge |
| `isingq_modeling_guide_get` | Get QUBO modeling guidance |
| `isingq_solve` | Model artifacts, target selection, device management, submission, and task queries |

Advanced integrations can explicitly use `serve --technical` for 20 tools. Normal use does not require switching.

## Documentation

[Installation guide](https://github.com/ising-tech/isingq-toolkit/blob/main/skills/install-isingq-mcp/SKILL.md) · [Development and integration](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/DEVELOPMENT.md) · [Toolkit overview](https://github.com/ising-tech/isingq-toolkit#readme) · [Issues](https://github.com/ising-tech/isingq-toolkit/issues) · [Apache-2.0](https://github.com/ising-tech/isingq-toolkit/blob/main/LICENSE)
