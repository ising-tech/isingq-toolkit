# @ising-tech/isingq-mcp

IsingQ 的标准 stdio MCP 服务，为 Agent 提供公开知识、QUBO 建模指导与校验，以及云端／内网本地求解器接入。

简体中文 · [English](README.en.md)

本文适用于 **0.9.x**，安装以 npm 或 GitHub Release 实际发布为准。

## 快速开始

不熟悉终端或 MCP 配置时，把下面这段话发送给当前 Agent：

```text
请从 https://github.com/ising-tech/isingq-toolkit 读取
skills/install-isingq-mcp/SKILL.zh-CN.md，按说明帮我安装 IsingQ MCP，
并且只接入当前 Agent。
不要在对话中索要或显示我的 API Key；需要云端 Key 时使用系统安全输入框，
仅使用本地求解器时不要求配置云端 Key。
安装完成后先重连 isingq MCP；不支持动态重载时再提示我重启，
然后核对实际加载版本及对应的 MCP 工具。
```

安装引导会根据当前 Agent 和操作系统选择一种接入方式，不会自动修改电脑上的其他 Agent。Host 不支持自动注册时，会提供可手工导入的 stdio 配置。

### 手动接入

支持 WorkBuddy、Claude Code、Cursor、VS Code 等 stdio MCP Host。使用下方 npx 方式需要 Node.js **18.17+** 和 npm。

以下以 `mcpServers` 格式为例，在 Host 的 MCP 设置中保存后重连：

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

也可运行以下命令查看配置，导入其中的 `mcpServers` 设置：

```bash
npx @ising-tech/isingq-mcp config --json --npx
```

重连后核对实际加载版本和下方四个工具；Host 无法动态重载时再重启。

## 基本使用

直接向 Agent 描述问题，例如：

```text
请把 A、B、C 分为两组，让跨组边权之和最大：AB=3、AC=2、BC=1，人数不限。
先展示变量、目标函数、约束和矩阵摘要，确认求解时让我选择云端或本地设备，等我确认后再提交。
```

- **云端**：选择公开机型；实际提交前，在[云平台](https://console.isingq.com/api-keys)创建个人 API Key，通过安全输入框配置，并明确选择算力券或账户余额。
- **本地**：对 Agent 说“添加／管理本地求解器”，填写连接名称和服务地址并测试连接。支持多台设备，不需要云端 API Key，不使用云端算力券或余额。

仅建模和校验无需云端凭据；保存设备配置不会提交求解。每次提交前需要明确确认，调用记录保留原目标的实际查阅位置。API Key 不应进入聊天、MCP JSON 或日志。

## 默认工具

| 工具 | 用途 |
| --- | --- |
| `isingq_api_key_setup` | 通过安全输入框配置云端 API Key |
| `isingq_knowledge_get` | 查询本地公开知识 |
| `isingq_modeling_guide_get` | 获取 QUBO 建模指导 |
| `isingq_solve` | 建模产物、目标选择、设备管理、求解提交与任务查询 |

高级集成可显式使用 `serve --technical`，提供 20 个工具；普通使用无需切换。

## 详细文档

[安装指引](https://github.com/ising-tech/isingq-toolkit/blob/main/skills/install-isingq-mcp/SKILL.zh-CN.md) · [开发与集成](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/DEVELOPMENT.md) · [Toolkit 总览](https://github.com/ising-tech/isingq-toolkit#readme) · [问题反馈](https://github.com/ising-tech/isingq-toolkit/issues) · [Apache-2.0](https://github.com/ising-tech/isingq-toolkit/blob/main/LICENSE)
