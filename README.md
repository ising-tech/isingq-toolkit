<p align="center">
  <img src="docs/assets/isingq-logo.png" width="500" alt="北京伊辛智能科技有限公司">
</p>

<h1 align="center">IsingQ Toolkit</h1>

> 源码版本 0.8.0：新增本地交付校验和轮次产物能力。当前尚未发布；下方发行版安装方式不代表已经能下载此版本。新能力请使用经测试的固定源码/本地制品，旧全局安装不会自动升级。

<p align="center">
  让 Agent 帮助你完成 QUBO 建模、校验并调用 IsingQ 求解
</p>

<p align="center">
  简体中文 · <a href="README.en.md">English</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="https://console.isingq.com/">获取 API Key</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ising-tech/isingq-dsh-plugin"><img src="https://img.shields.io/npm/v/@ising-tech/isingq-dsh-plugin?label=DSH%20Plugin" alt="IsingQ DSH Plugin npm version"></a>
</p>

<p align="center">
  <img src="docs/assets/isingq-toolkit-capabilities-demo.gif" width="800" alt="旧版建模与求解流程示意，非本次验收证据">
</p>

> **旧版流程示意，非本次实测或效果证据。** 图中确认是 Agent/Host 的流程义务，不是 MCP 对人工授权的不可伪造强绑定。自然语言可能由联网 LLM 宿主处理；API Key 默认保存在本机私有文件中，但会经 HTTPS 用于 IsingQ 平台鉴权。“78.25%”等示例比例缺少原始输入与复核记录，尚未核验，不作为实测改善或普遍收益。

IsingQ Toolkit 是北京伊辛智能科技有限公司公开维护的本地 Agent 工具。

你可以直接描述排程、路径规划、投资组合或图优化问题，由 Agent 协助构建 QUBO，并使用你自己的 IsingQ API Key 发起求解。

- 建模引导、QUBO 校验和结果记录在用户电脑上完成。
- 只有调用求解工具时，矩阵才会通过 HTTPS 提交给 IsingQ。
- API Key 默认保存在本机私有文件中；Headless 管理员也可在 Agent 进程启动前注入环境变量。Agent 不得索要、设置或显示 Key。
- 支持标准 MCP、Codex Plugin 和 DeepSeek Harness 原生 Plugin。

本项目提供辅助建模与声明范围内的确定性校验，不自动证明自然语言业务完整性或 QUBO 等价。云端求解器算法、解质量、耗时与返回方案属于外部服务；本项目维护工具接入、如实呈现返回与已有复算，不承诺全局最优或普遍性能优势。Host 后加的业务解释仍须单独核验。

## 快速开始

不熟悉终端或 MCP 配置时，把下面这段话发送给当前 Agent：

```text
请从 https://github.com/ising-tech/isingq-toolkit 读取
skills/install-isingq-mcp/SKILL.zh-CN.md，严格遵循该 Skill，
帮我安装 IsingQ MCP，并且只接入当前 Agent。
不要在对话中索要或显示我的 API Key；需要 Key 时使用系统安全输入框。
安装完成后先重连 isingq MCP；如果当前 Agent 不支持动态重载，
再等我重启 Agent，然后验证是否加载出 9 个 MCP 工具。
```

安装 Skill 会根据当前 Agent 和操作系统选择一种接入方式，不会自动修改电脑上的其他 Agent。Host 不支持自动注册时，Skill 会输出可手工导入的 stdio JSON。

完成接入后应能在标准 MCP Host 中看到 9 个 `isingq_*` 工具。DSH 原生 Plugin 提供 11 个工具。

### 安装演示

<p align="center">
  <img src="docs/assets/isingq-toolkit-install-demo.gif" width="800" alt="旧版安装流程示意，7/7不代表当前工具数">
</p>

> **旧版安装示意，非当前版本验收证据。** 图中的“7/7”属于旧版；当前标准 MCP 应枚举 9 个工具，是否实际加载需按最终固定候选核对，不能由此动画认定。

## 第一次求解

知识查询、建模引导和 QUBO 校验不需要 API Key。只有提交真实求解任务时才需要个人 IsingQ API Key。

1. 登录或注册[玉盘·伊辛云](https://console.isingq.com/)。
2. 进入 **设置 → API → 创建API**，创建便于识别的个人 API Key。
3. 让 Agent 调用 `isingq_api_key_setup`，在系统安全输入框中填写 Key。
4. 直接向 Agent 描述需要建模的问题。

不要把 API Key 发到 Agent 对话、命令参数、MCP JSON、Issue 或日志中。如果 Key 意外泄露，请在云平台删除对应记录并重新创建。

Headless 部署无法使用系统输入框时，部署管理员可以在 Agent 进程启动前设置 `ISINGQ_API_KEY`。这不是 Agent 安装步骤；Agent 不得读取、设置或回显该变量。

可以从这个示例开始：

```text
请把下面的问题建成 QUBO。先解释变量、目标函数、约束和 Penalty，展示矩阵摘要，等我确认后再调用 IsingQ 求解：

任务 A、B 只能选择一个；选择 A 的收益为 8，选择 B 的收益为 5。
```

Agent 应先展示变量映射、目标函数、约束、Penalty、矩阵摘要和 SHA-256。你确认后，Agent 才应调用 `isingq_solve_start`。

云提交前必须明确付款选择：`solver_options.use_credit=true` 使用算力券，`false` 使用账户余额；缺选择先询问，不得自动代选或切换。历史任务用 poll/get 读取；改变付款或其他参数前先核查原任务并重新确认，不能更换幂等键绕过失败或受理不明状态。

该工具被 Host 放行后会立即创建远端任务。MCP 不再弹出额外的操作系统求解确认框；Host 是否再次确认取决于它自身的工具权限设置。当前 MCP 不验证不可伪造的人工授权记录，也未将此类记录与模型、参数强绑定；前述确认是 Agent/Host 的流程义务。

## 还能做什么

除了求解，Toolkit 还包含本地公开知识和 QUBO 建模指导。例如：

```text
玉盘·伊辛云目前提供什么能力？请给出知识版本、来源和表述边界。
```

```text
请先检查这个 QUBO 的维度、对称性、系数范围和矩阵摘要，不要提交求解。
```

云平台 API 当前支持最高 2048 个 QUBO 二进制变量。具体任务是否适合当前规模，仍取决于建模方式和约束展开结果。

## 支持范围

| 接入方式 | 适用范围 | 是否需要 Node.js |
| --- | --- | --- |
| 标准 MCP | WorkBuddy、Claude Code、Cursor、VS Code 等 MCP Host | npx 方式需要 Node.js 18.17+；Release 不需要 |
| Codex Plugin | Codex Repo Marketplace 接入 | 需要 Node.js 18.17+ |
| DSH 原生 Plugin | DeepSeek Harness | 由 DSH 管理 |

标准 MCP 的 Release 程序支持 macOS arm64/x64、Linux arm64/x64 和 Windows x64。同一台电脑只需要一份运行程序，不同 Agent 可以分别注册它。

## 其他安装方式

快速开始中的 Agent Skill 是普通用户的推荐入口。下面的命令适合需要手动管理安装或配置的用户。

### Codex Repo Marketplace

需要 Node.js 18.17 或更高版本。先添加官方仓库 Marketplace，再安装 Plugin：

```bash
codex plugin marketplace add ising-tech/isingq-toolkit --ref main
codex plugin add isingq-mcp@isingq-toolkit
```

安装后新建 Codex 任务，并让 Codex“配置我的 IsingQ API Key”。Plugin 会通过系统安全输入框完成配置，不要在对话中粘贴 API Key。

### npm / npx

需要 Node.js 18.17 或更高版本：

```bash
npx @ising-tech/isingq-mcp setup
npx @ising-tech/isingq-mcp configure-host --name generic --npx
```

将 `generic` 替换为实际支持的 Host 名称。需要手工注册的 Host 保持使用 `generic`，并在其 MCP 设置中导入输出的 stdio JSON。

### GitHub Release

不希望安装 Node.js 时，从 [GitHub Releases](https://github.com/ising-tech/isingq-toolkit/releases) 下载对应系统的固定版本程序，并使用随 Release 提供的 `SHA256SUMS` 校验文件。

### DeepSeek Harness

DSH 使用原生 Plugin，不需要 MCP Bridge。安装前可以查看 [npm 包](https://www.npmjs.com/package/@ising-tech/isingq-dsh-plugin)与[完整使用说明](packages/dsh-plugin/README.md)：

```bash
dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin
```

卸载：

```bash
dsh plugin --profile <profile> remove @ising-tech/isingq-dsh-plugin
```

最低兼容基线为 DeepSeek Harness `0.1.0-rc.7`，当前开发验证版本为 `0.2.2-rc.1`。`engines.dsh` 与 `@deepseek-ai/dsh-tools` peer 范围同为 `>=0.1.0-rc.7 <0.3.0-0`，同时覆盖 `0.1.x` 与 `0.2.x` 运行时。

不要在同一个 DSH Profile 中同时启用 IsingQ 原生 Plugin 和旧 MCP Bridge。详细说明见 [DSH Plugin README](packages/dsh-plugin/README.md)。

### 源码开发

从源码运行、架构说明、包边界和 Release 流程统一放在[开发者文档](docs/DEVELOPMENT.md)，不建议普通用户通过源码安装。

## 工具能力

| 工具 | 作用 | 是否联网 |
| --- | --- | --- |
| `isingq_api_key_setup` | 打开系统安全输入框，配置或更换个人 API Key | 否 |
| `isingq_knowledge_get` | 查询公开的公司、产品、技术、案例、FAQ 和来源知识 | 否 |
| `isingq_modeling_guide_get` | 获取 QUBO 建模步骤和约束说明 | 否 |
| `isingq_qubo_validate` | 校验 QUBO 并生成矩阵摘要 | 否 |
| `isingq_delivery_validate` | 本地校验交付契约并生成客观摘要；不证明业务正确性或测试真实性 | 否 |
| `isingq_report_verify` | 本地复算声明模型的候选目标、可行性与排名；不核验额外自然语言解释 | 否 |
| `isingq_solve_start` | 被 Host 放行后立即提交 IsingQ 求解 | 是 |
| `isingq_solve_poll` | 查询一次任务状态并保存结果 | 是 |
| `isingq_solve_result_get` | 读取本机保存的求解结果 | 否 |

DSH 原生 Plugin 还提供 `isingq_resource_list` 和 `isingq_resource_read`，用于列出和读取本机版本化公开知识资源。

`isingq_qubo_validate` 同时返回矩阵 `matrix_sha256` 和带版本的完整模型摘要 `model_sha256`、`model_digest_version`。完整模型摘要包含变量数量、系数、offset 和变量映射；修改 offset 或变量含义会改变完整模型摘要，即使上传矩阵没有变化。校验完全在本机执行。集成接口与精确规则见 [core 说明](packages/core/README.md)和[摘要规范](packages/core/MODEL-DIGEST.md)。

## 数据与结果口径

- API Key 默认从本机私有文件读取；Headless 管理员可在进程启动前注入 `ISINGQ_API_KEY`，运行时不会持久化该变量。
- Agent 不得接收、设置或打印 API Key；Key 不进入工具参数、对话、Host 配置或日志。
- 生产 API 固定为 `https://api.isingq.com`。
- 建模引导、QUBO 校验和公开知识查询在本机完成。
- `isingq_solve_start` 被 Host 放行后会发送求解矩阵。
- API 请求使用 HTTPS；矩阵上传使用短期签名，不携带个人 API Key。
- 本地记录包含模型、任务 ID 和结果，不包含 API Key。

求解结果同时保留两种数值。

**IsingQ provider energy**

```math
E(s) = -\frac{1}{2}\sum_i\sum_j J_{ij}s_i s_j - \sum_i h_i s_i
```

**MCP 按 QUBO 重新计算的 objective**

```math
f(x) = \mathrm{offset} + \sum_i Q_{ii}x_i + \sum_{i \lt j} Q_{ij}x_i x_j
```

两者可能因变量转换、常数项或系数口径不同而不相等。最低 energy 也不自动代表业务可行、全局最优或特定硬件性能。

更多安全边界见 [Security Policy](SECURITY.md)。

## 升级与故障排查

- **升级**：重新执行安装 Skill，或更新当前使用的 npm、Release、Codex Plugin、DSH Plugin。
- **已有配置**：升级会保留本机 API Key 和求解记录。
- **缺少 Key 后重试**：通过 `isingq_api_key_setup` 配置 Key 后，可用相同模型和 `idempotency_key` 再次提交；缺 Key 的新调用不会留下求解记录。
- **提交失败或结果未知**：只有能确认尚未创建远端任务的失败才允许同 key 重试。遇到 `submission_unknown` 或无法判定提交阶段的旧失败记录时，先到云平台核对任务；不要自动更换 key 或删除记录后重提。
- **工具未出现**：先在 Host 中重连 `isingq` 并批准信任提示；仍未加载时再完全重启 Agent。
- **Host 无法自动接入**：运行 `isingq-mcp config --json`，通过 Host 的 MCP 设置页面导入。
- **沙箱禁止写入**：只授权准确的安装目录和用户配置目录，不要把 API Key 放进项目目录。
- **只得到 NDJSON 响应**：这只能证明进程可访问；在 Agent 中出现 9 个原生工具才表示标准 MCP 接入完成。

## 项目与开发

架构、包边界、QUBO 数据契约、构建与 Release 流程见[开发者文档](docs/DEVELOPMENT.md)。问题与建议可以通过 [GitHub Issues](https://github.com/ising-tech/isingq-toolkit/issues) 提交。

本项目使用 [Apache License 2.0](LICENSE)。该许可证不授予 IsingQ 或伊辛智能相关商标权。

## 本地业务核验与报告（0.8.0 源码）

`validateMathModel`、`evaluateMathCandidate`、`compareMathCandidates` 复用有限数学模型契约；`buildVerifiedReport` 从同次核验生成目标分项、提供候选中的排名、基线改善与约束余量。CLI/MCP/DSH共享该核心，不按业务类型分支。不可行方案不入榜；取等不代表约束冗余；不推断全局最优、QUBO等价或实测收益。输入、错误与支持范围见 [核心报告契约](packages/core/VERIFIED-REPORT.md)。

此为源码变更，不表示已发布或已升级全局安装。本地报告不调用云求解、安装程序或凭据。
