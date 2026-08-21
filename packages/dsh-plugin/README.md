# @ising-tech/isingq-dsh-plugin

Native IsingQ integration for DeepSeek Harness. The Plugin registers nine typed tools in the DSH process and reuses `@ising-tech/isingq-core` for QUBO guidance, validation, public knowledge, HTTPS solving, and local result records.

[中文说明](#中文说明)

## Install

Install the Plugin into the DSH Profile you actually use:

```bash
dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin
```

Replace `<profile>` with the real Profile name, restart that Profile, and confirm that nine `isingq_*` tools are available. Do not enable this native Plugin and an IsingQ MCP bridge in the same Profile.

## Configure an API Key

1. Sign in or register at [IsingQ Cloud](https://console.isingq.com/).
2. Open **Settings → API → Create API** and create a personal API Key.
3. Ask the Agent to call `isingq_api_key_setup`, then enter the Key in the operating system's private prompt.

The API Key is stored in a private local file and used only for HTTPS authentication with the IsingQ API. It does not enter Agent chat, tool arguments, DSH Profile configuration, issues, or logs.

## Solve safely

Before `isingq_solve_start`, the Agent must show the variable mapping, objective, constraints, penalties, matrix summary, and SHA-256, then obtain your explicit confirmation.

Once the DSH Host permits `isingq_solve_start`, the Plugin creates the remote task immediately. It does not open a second operating-system solve prompt; any additional confirmation is controlled by the Host's tool-permission policy.

## Tools

| Tool | Purpose | Network |
| --- | --- | --- |
| `isingq_api_key_setup` | Configure or replace the local API Key through a private OS prompt | No |
| `isingq_knowledge_get` | Read versioned public IsingQ knowledge | No |
| `isingq_modeling_guide_get` | Get QUBO modeling and constraint guidance | No |
| `isingq_qubo_validate` | Validate a QUBO and produce a matrix summary | No |
| `isingq_solve_start` | Submit a confirmed QUBO solve task | Yes |
| `isingq_solve_poll` | Query task status once and save the result | Yes |
| `isingq_solve_result_get` | Read a locally stored solve result | No |
| `isingq_resource_list` | List local public knowledge resources | No |
| `isingq_resource_read` | Read one local public knowledge resource | No |

## Data boundary

Modeling guidance, QUBO validation, public knowledge, and result records stay on the user's computer. A QUBO matrix is sent to IsingQ only after the confirmed solve tool is called.

API requests use HTTPS. Matrix upload uses a short-lived signature and does not carry the personal API Key. The Key remains outside Agent-visible inputs and outputs.

## Compatibility

- Node.js 18 or later.
- Minimum supported DeepSeek Harness baseline: `0.1.0-rc.7`.
- `@deepseek-ai/dsh-tools` peer range: `>=0.1.0-rc.7 <0.2.0-0`.
- Current development validation version: `0.1.0-rc.8`.

The peer range permits later compatible `0.1` releases, but versions newer than the current validation baseline are not automatically claimed as runtime-verified.

## Troubleshooting

- **Tools are missing:** verify the target Profile, remove any duplicate IsingQ MCP bridge, then restart that Profile.
- **API Key is missing:** call `isingq_api_key_setup`; never paste the Key into Agent chat.
- **Installation reports a peer conflict:** confirm that DSH is within the documented `0.1` compatibility range.

---

## 中文说明

这是面向 DeepSeek Harness 的 IsingQ 原生 Plugin。它在 DSH 进程内注册 9 个 typed tools，并复用 `@ising-tech/isingq-core` 提供 QUBO 建模引导、校验、公开知识、HTTPS 求解和本地结果记录。

## 安装

安装到实际使用的 DSH Profile：

```bash
dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin
```

将 `<profile>` 替换为真实 Profile 名，重启该 Profile 后确认出现 9 个 `isingq_*` 工具。不要在同一个 Profile 中同时启用该原生 Plugin 和 IsingQ MCP Bridge。

## 配置 API Key

1. 登录或注册[玉盘·伊辛云](https://console.isingq.com/)。
2. 进入 **设置 → API → 创建API**，创建个人 API Key。
3. 让 Agent 调用 `isingq_api_key_setup`，在操作系统私密输入框中填写 Key。

API Key 保存在本机私有文件中，只用于 IsingQ API 的 HTTPS 鉴权。它不会进入 Agent 对话、工具参数、DSH Profile 配置、Issue 或日志。

## 安全求解

调用 `isingq_solve_start` 前，Agent 必须展示变量映射、目标函数、约束、Penalty、矩阵摘要和 SHA-256，并取得你的明确确认。

DSH Host 放行 `isingq_solve_start` 后，Plugin 会立即创建远端任务，不再弹出第二个操作系统求解确认框。是否增加确认由 Host 的工具权限策略决定。

## 工具

| 工具 | 作用 | 是否联网 |
| --- | --- | --- |
| `isingq_api_key_setup` | 通过操作系统私密输入框配置或更换 API Key | 否 |
| `isingq_knowledge_get` | 查询版本化的 IsingQ 公开知识 | 否 |
| `isingq_modeling_guide_get` | 获取 QUBO 建模与约束引导 | 否 |
| `isingq_qubo_validate` | 校验 QUBO 并生成矩阵摘要 | 否 |
| `isingq_solve_start` | 提交已经确认的 QUBO 求解任务 | 是 |
| `isingq_solve_poll` | 查询一次任务状态并保存结果 | 是 |
| `isingq_solve_result_get` | 读取本机保存的求解结果 | 否 |
| `isingq_resource_list` | 列出本机公开知识资源 | 否 |
| `isingq_resource_read` | 读取一项本机公开知识资源 | 否 |

## 数据边界

建模引导、QUBO 校验、公开知识和结果记录在用户电脑上完成。只有用户确认并调用求解工具后，QUBO 矩阵才会提交到 IsingQ。

API 请求使用 HTTPS。矩阵上传使用短期签名，不携带个人 API Key；Key 不会进入 Agent 可见的输入或输出。

## 兼容性

- Node.js 18 或更高版本。
- DeepSeek Harness 最低兼容基线：`0.1.0-rc.7`。
- `@deepseek-ai/dsh-tools` peer range：`>=0.1.0-rc.7 <0.2.0-0`。
- 当前开发验证版本：`0.1.0-rc.8`。

该范围允许后续兼容的 `0.1` 版本安装，但不会把高于当前验证基线的版本自动描述为已经完成运行验证。

## 故障排查

- **没有出现工具：**确认目标 Profile，移除重复的 IsingQ MCP Bridge，再重启该 Profile。
- **缺少 API Key：**调用 `isingq_api_key_setup`，不要把 Key 粘贴到 Agent 对话。
- **安装出现 peer 冲突：**确认 DSH 位于文档声明的 `0.1` 兼容范围内。
