# @ising-tech/isingq-dsh-plugin

Native IsingQ integration for DeepSeek Harness: QUBO modeling, validation, and cloud or private-network local solving, using `@ising-tech/isingq-core` inside the DSH process.

[简体中文](README.md) · English

This guide covers **0.9.x**, which registers **21 tools**. Install only versions actually published on [npm](https://www.npmjs.com/package/@ising-tech/isingq-dsh-plugin), then verify the loaded version. A source checkout does not establish release availability.

## Install

### In the app

In DeepSeek Harness, open **Plugins → Add plugin**, enter `@ising-tech/isingq-dsh-plugin`, and click **Install**. Follow the on-screen prompts; no terminal is needed.

### Command line

Install into the Profile you actually use:

```bash
dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin
```

For the macOS desktop app, fully quit it first, use its bundled CLI at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`, and select the active `desktop` Profile. Use the actual Profile for other entrypoints.

Reopen and verify the loaded Plugin version and its tools. npm installs published versions; local device support in this guide requires 0.9.x. Avoid enabling an IsingQ MCP bridge alongside the native Plugin in the same Profile.

Requirements: Node.js **18.17+**; DSH and `@deepseek-ai/dsh-tools` **`>=0.1.0-rc.7 <0.3.0-0`**. The development validation baseline is DSH `0.2.2-rc.1`.

## Basic use

Describe your problem to the Agent. Review the variables, objective, constraints, and matrix summary, then choose a target at solve confirmation and explicitly approve submission:

- **Cloud**: browse public models and suitability advice. For actual submission, create a personal API Key in the [cloud console](https://console.isingq.com/api-keys), configure it through the private `isingq_api_key_setup` prompt, and choose a compute voucher or account balance.
- **Local**: ask to add/manage local solvers; enter a device name and service address and test the connection. Multiple devices are supported, without a cloud API Key, voucher, or account balance.

Advice does not block your target choice. Saving a local connection does not submit a task. Each call record keeps its actual target and viewing location, pointing to the cloud console or a locally accessible address.

Keep API Keys out of chat, tool arguments, Profile configuration, and logs. Cloud tasks send the matrix to IsingQ; local tasks send it to the selected device.

## Updates, removal, and help

Keep the original Profile and distribution when updating. Use DSH's plugin management to install a published version, reload, and verify the loaded version. Toolkit's built-in version check provides notices only.

Remove with:

```bash
dsh plugin --profile <profile> remove @ising-tech/isingq-dsh-plugin
```

- **Missing tools**: check the Profile and duplicate MCP bridges; reload, then restart if needed.
- **Version conflict**: check the DSH and SDK compatibility range above.
- **Local connection failure**: check the network and service address, then test on the management page.
- **Cloud authentication failure**: replace the Key through the private prompt; never paste it into chat.

[Toolkit guide](https://github.com/ising-tech/isingq-toolkit/blob/main/README.en.md) · [Integration and developer acceptance](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/DEVELOPMENT.md) · [Solver target API](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/solver-targets.md) · [Apache-2.0](LICENSE)
