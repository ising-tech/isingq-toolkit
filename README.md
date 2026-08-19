# IsingQ Toolkit

[English](README.en.md) | 简体中文

IsingQ Toolkit 是北京伊辛智能科技有限公司公开维护的本地 Agent 工具。它帮助 Agent 将排程、路径规划、投资组合、图优化等问题表达为 QUBO，在用户确认后使用用户自己的 IsingQ API Key 调用玉盘·伊辛云求解。

- 建模引导、QUBO 生成、校验和结果记录在用户电脑上完成。
- 只有用户确认后的求解矩阵会通过 HTTPS 发送给 IsingQ。
- 支持 WorkBuddy、Codex、Claude Code、Cursor、VS Code、Trae 和 DeepSeek Harness。
- 标准 MCP 提供 7 个工具和 13 个本地 Resources；DSH 原生 Plugin 提供 9 个工具。
- 云平台 API 当前支持最高 2048 个 QUBO 二进制变量。

## 开始前：获取 IsingQ API Key

真实求解必须使用个人 IsingQ API Key。知识查询、建模引导和 QUBO 校验不需要 API Key。

1. 打开 [玉盘·伊辛云](https://console.isingq.com/) 并注册或登录个人账号。
2. 在平台中进入 **设置 → API**。
3. 点击 **创建API**，填写便于识别的 API 名称并完成创建。
4. 安装时通过操作系统安全输入框保存 API Key。

平台的创建路径也记录在[玉盘·伊辛云网站隐私政策](https://docs.isingq.com/privacy_policy.html)的“设置”服务说明中。

不要把 API Key 发到 Agent 对话、命令参数、MCP JSON、Issue 或日志中。如果 Key 意外泄露，请回到云平台的 **设置 → API** 删除对应记录并重新创建。

## 推荐安装：让 Agent 读取 Skill

把下面这段话发送给当前 Agent：

```text
请从 https://github.com/ising-tech/isingq-toolkit 读取 skills/install-isingq-mcp/SKILL.zh-CN.md，严格遵循该 Skill，帮我安装 IsingQ MCP，并且只接入当前 Agent。不要在对话中索要或显示我的 API Key；需要 Key 时使用系统安全输入框。安装完成后，等我重启 Agent，再验证是否加载出 7 个 MCP 工具。
```

安装 Skill 会选择当前操作系统和当前 Agent，不会因为电脑上安装了其他 Agent 就全部配置。Trae 需要把 Skill 输出的 stdio JSON 导入 MCP 设置页面。

安装成功应满足：

- 程序安装并通过哈希校验。
- 本机已有有效 API Key。
- 当前 Agent 已注册 MCP。
- 重启后标准 MCP 加载 7 个工具，或 DSH 原生 Plugin 加载 9 个工具。

## 从 GitHub 源码安装

当前公开仓库可以直接测试。需要 Node.js 18 或更高版本：

```bash
git clone https://github.com/ising-tech/isingq-toolkit.git
cd isingq-toolkit
npm ci
npm install -g .
isingq-mcp setup
isingq-mcp self-check --json
```

`isingq-mcp setup` 会以无回显方式接收 API Key。然后只配置实际使用的 Agent：

```bash
isingq-mcp configure-host --name workbuddy
```

`--name` 支持 `workbuddy`、`codex`、`claude-code`、`cursor`、`vscode` 和 `generic`。Trae 或其他 Host 可获取标准配置后手工导入：

```bash
isingq-mcp config --json
```

通用 stdio 配置如下：

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

配置后请完全退出并重新启动 Agent。

## npm、Release 与 DSH

有 Node.js 18 或更高版本时，直接通过 npm/npx 安装和配置：

```bash
npx @ising-tech/isingq-mcp setup
npx @ising-tech/isingq-mcp configure-host --name generic --npx
```

将 `generic` 替换为实际使用的 `workbuddy`、`codex`、`claude-code`、`cursor` 或 `vscode`；Trae 保持使用 `generic` 并导入输出的 stdio JSON。

不希望安装 Node.js 的用户可以从 [GitHub Releases](https://github.com/ising-tech/isingq-toolkit/releases) 下载对应系统的固定版本程序，并使用 `SHA256SUMS` 校验。支持 macOS arm64/x64、Linux arm64/x64 和 Windows x64。

DeepSeek Harness 使用原生 Plugin，不需要 MCP Bridge：

```bash
dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin
```

不要在同一个 DSH Profile 中同时启用 IsingQ 原生 Plugin 和旧 MCP Bridge。

## 如何使用

安装并重启后，直接向 Agent 描述问题，不需要记忆工具名：

```text
请把下面的排程问题建成 QUBO。先解释变量、目标函数、约束和 Penalty，等我确认后再调用 IsingQ 求解：

任务 A、B 只能选择一个；选择 A 的收益为 8，选择 B 的收益为 5。
```

Agent 应先完成建模和校验，展示变量映射、目标函数、约束、Penalty、矩阵摘要和 SHA-256。只有你明确确认并通过操作系统确认框后，才会提交求解。

也可以查询本地公开知识：

```text
玉盘·伊辛云目前提供什么能力？请给出知识版本、来源和表述边界。
```

## 工具能力

| 工具 | 作用 | 是否联网 |
| --- | --- | --- |
| `isingq_api_key_setup` | 打开系统安全输入框，配置或更换个人 API Key | 否 |
| `isingq_knowledge_get` | 查询伊辛智能、产品、技术、案例、FAQ 和来源 | 否 |
| `isingq_modeling_guide_get` | 获取 QUBO 建模步骤和约束 | 否 |
| `isingq_qubo_validate` | 校验 QUBO 并生成矩阵摘要 | 否 |
| `isingq_solve_start` | 用户确认后提交 IsingQ 求解 | 是 |
| `isingq_solve_poll` | 查询一次任务状态并保存结果 | 是 |
| `isingq_solve_result_get` | 读取本机保存的求解结果 | 否 |

求解结果同时保留：

- IsingQ provider energy：`E(s) = -1/2 · Σ_i Σ_j J_ij s_i s_j - Σ_i h_i s_i`。
- MCP 按 QUBO 重新计算的 objective：`f(x) = offset + Σ_i Q_ii x_i + Σ_{i<j} Q_ij x_i x_j`。

两者可能因变量转换、常数项或系数口径不同而不相等。最低 energy 也不自动代表业务可行、全局最优或特定硬件性能。

## 数据与安全

- API Key 只保存在本机私有文件中，不进入工具参数或对话。
- 建模引导、QUBO 校验和公开知识查询在本机完成。
- 只有 `isingq_solve_start` 会在用户确认后发送求解矩阵。
- API 请求使用 HTTPS；矩阵上传使用短期签名，不携带个人 API Key。
- 本地记录保存模型、任务 ID 和结果，不保存 API Key。

更多边界见 [Security Policy](SECURITY.md)。

## 升级与多 Agent

- 升级时重新执行安装 Skill 或重新安装 npm/Release 即可。
- 已有 API Key 和本地求解记录会保留。
- 每台电脑只需安装一份程序；不同 Agent 分别注册同一个本地程序即可。
- 更新配置后必须完全重启对应 Agent。

## 遇到问题

- **没有 API Key**：前往[玉盘·伊辛云](https://console.isingq.com/)的 **设置 → API → 创建API**。
- **Agent 没有出现工具**：确认配置后完全重启 Agent，并批准其 MCP 信任提示。
- **Agent 沙箱禁止写入**：只授权明确的安装目录和用户配置目录；不要把 API Key 放进项目目录。
- **Trae 无法自动接入**：运行 `isingq-mcp config --json`，通过 Trae MCP 设置页面导入。
- **只测试出 NDJSON 响应**：这只能说明进程可访问；必须在 Agent 中看到 7 个原生工具才算接入完成。

## 开发者文档

架构、包边界、QUBO 数据契约、构建与 Release 流程见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

本项目使用 [Apache License 2.0](LICENSE)。该许可证不授予 IsingQ 或伊辛智能相关商标权。
