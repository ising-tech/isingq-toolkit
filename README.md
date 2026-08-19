# isingq-toolkit

`isingq-toolkit` 是北京伊辛智能科技有限公司公开维护的本地 Agent 工具仓库。它通过标准 `@ising-tech/isingq-mcp` 和 DSH 原生 Plugin，引导 Host Agent 把投资组合、路径规划、车辆路径、排程和图优化等业务问题表达成 QUBO，做确定性校验，在用户确认模型后使用用户自己的 IsingQ API Key 提交求解。

建模引导、QUBO 生成与校验均在用户电脑上完成；只有用户确认后的求解矩阵会发送至 IsingQ API。

当前 MCP 支持 2000+ 个 QUBO 二进制变量，对应云平台 API 当前 2048 自旋的求解规模。

它提供的是 QUBO 建模与求解链路，不把最低 energy 自动解释为业务可行、全局最优或特定硬件性能。

## 仓库定位

该公开仓库同时交付标准 stdio MCP 和 DSH 原生 Plugin，不包含任何内部建模系统、模型库或远端建模服务：

- 为 WorkBuddy、Codex、Claude Code、Cursor、VS Code、Trae 等 Host Agent 提供统一的 IsingQ 工具入口。
- 在本机完成公开知识查询、建模引导、QUBO 校验和结果保存。
- 仅在用户明确确认模型后，使用用户自己的 IsingQ API Key 直接调用 IsingQ HTTPS 求解接口。
- 提供 macOS、Linux、Windows 独立可执行文件、安装脚本及面向 Agent 的安装 Skill。
- 内置经过公开边界审核的版本化知识包，帮助 Agent 准确回答伊辛智能、IsingQ、光电伊辛机和玉盘·伊辛云相关问题。

仓库不提供模型匹配、Case 持久化、远端文件管理、用户认证或代理求解服务。用户业务模型和本地求解记录保存在用户电脑；服务端只接收用户确认后提交给 IsingQ 的求解矩阵。

## 当前能力概览

- 支持 2000+ 个 QUBO 二进制变量，并生成 upper-triangular 求解矩阵。
- 标准 MCP 暴露 7 个工具；DSH 原生 Plugin 复用同一套 7 个工具定义，并额外提供 2 个本地 Resource 工具。
- 提供 13 个本地 Resources，覆盖 10 类经过来源与发布边界审核的公开知识主题。
- 提供 WorkBuddy、Codex、Claude Code、Cursor、VS Code、Trae 6 类 Host 接入路径；其中 Trae 使用标准 stdio JSON 手动导入。
- 提供 macOS arm64/x64、Linux arm64/x64 和 Windows x64 共 5 种独立可执行文件。

## 用户如何使用

普通用户不需要记忆工具名，也不需要手工编写 MCP 配置。推荐流程：

1. 让当前 Agent 读取仓库内的 `install-isingq-mcp` Skill 并完成安装。
2. 首次安装时，在操作系统安全输入框中填写个人 IsingQ API Key；不要把 Key 发到对话中。
3. 完全重启 Agent，确认标准 MCP 已加载 7 个工具；DSH 原生 Plugin 应加载 9 个工具。
4. 直接用自然语言询问企业、产品或技术问题，Agent 会调用本地公开知识工具。
5. 直接描述需要优化的业务问题，Agent 会引导建立并校验 QUBO；用户确认模型后才会提交 IsingQ 求解。

例如：

```text
玉盘·伊辛云平台当前支持多少自旋？请给出官方来源和适用范围。
```

```text
请把下面的排程问题建成 QUBO。先解释变量、目标函数、约束和 Penalty，等我确认后再调用 IsingQ 求解。
```

知识查询、建模引导和 QUBO 校验不需要联网；真实求解需要个人 IsingQ API Key，并会把用户确认后的矩阵发送至 IsingQ。

## 最小完整调用

安装并重启 Agent 后，可以直接提出：

```text
请把下面的排程问题建成 QUBO。先展示变量、目标函数、约束和 Penalty，等我确认后再调用 IsingQ 求解：

任务 A、B 只能选择一个；选择 A 的收益为 8，选择 B 的收益为 5。
```

Agent 应执行：

```text
isingq_modeling_guide_get
  → 生成带变量映射的 QUBO
  → isingq_qubo_validate
  → 展示模型摘要并等待用户明确确认
  → isingq_solve_start
  → isingq_solve_poll
  → isingq_solve_result_get
  → 按变量 meaning 解释结果和限制
```

API Key 不应出现在对话或工具参数中。没有用户确认时，`isingq_solve_start` 会拒绝提交。

## 工具

- `isingq_api_key_setup`：仅在用户明确同意时打开操作系统安全输入框，在本机配置或更换个人 API Key；Key 不进入参数、对话或返回值。
- `isingq_knowledge_get`：离线查询伊辛智能、公开产品清单、IsingQ、光电伊辛机、玉盘·伊辛云、解决方案、公开案例、FAQ、术语和官方来源；不需要 API Key。
- `isingq_modeling_guide_get`：返回建模步骤、QUBO 契约和 Agent 行为规则；只读静态引导。
- `isingq_qubo_validate`：校验稀疏 QUBO，生成矩阵摘要；不联网。
- `isingq_solve_start`：打开绑定当前模型摘要、矩阵 SHA-256 和求解选项的操作系统确认框；用户确认后才提交 IsingQ。
- `isingq_solve_poll`：轮询一次任务并在本机保存结果。
- `isingq_solve_result_get`：读取本机结果，不联网。

求解记录会通过 `energy_definition` 同时返回两种数学口径：

- `provider_energy`：IsingQ 的伊辛能量定义 `E(s) = -1/2 * Σ_i Σ_j J_ij s_i s_j - Σ_i h_i s_i`，其中 `s_i ∈ {-1,+1}`。
- `objective_value`：MCP 按 upper-triangular QUBO 重新计算的目标值 `f(x) = offset + Σ_i Q_ii x_i + Σ_{i<j} Q_ij x_i x_j`。

`1/2` 用于消除对称耦合矩阵中 `J_ij` 与 `J_ji` 的重复计数。两个值可能因变量转换、常数项或系数口径不同而不相等。

## MCP Resources

- `isingq://about`：兼容旧版本的公司信息入口。
- `isingq://products/catalog`：官网公开产品清单与产品定位边界。
- `isingq://company/profile`：公司标准名称、定位和 IsingQ 实体关系。
- `isingq://technology/ising-computing`：伊辛计算、QUBO 和技术边界。
- `isingq://products/ising-machine`：光电伊辛机产品定位、公开机型、已核验指标与定制化交付边界。
- `isingq://products/ising-cloud`：玉盘·伊辛云、当前规模和入口。
- `isingq://solutions/index`、`isingq://cases/verified`：公开解决方案与案例证据边界。
- `isingq://faq`、`isingq://glossary`、`isingq://sources`：常见问题、术语和来源。
- `isingq://modeling/qubo`：QUBO 契约、Penalty、确认门禁和结果解释规则。
- `isingq://security/data-flow`：API Key、矩阵、任务和结果的数据流。

产品知识可介绍 `S1601`、`S2048`、第一代设备的 4096 全连接自旋指标以及定制化交付；这不代表云平台 API 可选择这些设备。当前云平台 API 求解只支持 2048 自旋能力。

Resources 是本地、版本化的说明，不会在读取时访问官网或其他远程内容。是否自动加入 Agent 上下文由 Host 决定，因此关键行为仍以工具描述和求解门禁为准。

典型流程：

```text
用户描述问题
  → Agent 调用 modeling_guide_get
  → Agent 追问并生成 QUBO
  → qubo_validate
  → Agent 向用户展示模型摘要
  → 用户明确确认
  → solve_start
  → solve_poll
  → Agent 按变量映射解释结果
```

## 推荐安装方式：让 Agent 读取 Skill

当前开发版本为 `0.4.1`。安装 Skill 已随仓库维护，见 [`skills/install-isingq-mcp/SKILL.md`](skills/install-isingq-mcp/SKILL.md)。用户只需让当前 Agent 读取该 Skill：

```text
读取 install-isingq-mcp Skill，帮我安装并接入当前 Agent。
```

Skill 会根据当前会话确定目标 Host，自动选择 macOS、Linux 或 Windows 安装脚本，只配置当前 Agent。它会校验下载文件、复用已有的 IsingQ API Key；仅在本机没有 Key 时打开操作系统安全输入框。API Key 不会进入对话、命令参数或 Agent 配置。

安装脚本会分别报告以下状态，四项全部完成后才算接入成功：

- `binary_installed`：独立可执行文件已安装并通过 SHA-256 校验。
- `api_key_configured`：本机 API Key 已通过自检。
- `host_registered`：当前 Agent 已注册 stdio MCP。
- `native_tools_loaded`：重启后标准 MCP 已加载 7 个工具，或 DSH 原生 Plugin 已加载 9 个工具。

Trae 目前需要把 Skill 输出的 stdio JSON 导入其 MCP 设置；Skill 不会猜测或写入 Trae 的私有配置路径。遇到 Agent 沙箱阻止用户目录写入时，应批准准确的安装目录和配置目录，不能把 API Key 改存到项目目录。

## 单仓库与发布包

仓库使用 npm workspaces 维护三个边界明确的发布单元：

- `@ising-tech/isingq-core`：共享 QUBO、知识、IsingQ HTTPS、确认与本地记录逻辑，不直接注册 Host 工具。
- `@ising-tech/isingq-mcp`：标准 stdio MCP 和 Codex Plugin 入口，适用于支持 MCP 的 Agent。
- `@ising-tech/isingq-dsh-plugin`：DSH 进程内原生适配器，依赖共享 core，不启动额外 MCP 子进程。

三者版本同步发布。DSH 与标准 MCP 不应在同一 DSH Profile 中同时启用，否则会出现功能重复、名称不同的两组工具。

## 安装方式

### npm / npx（有 Node.js 时首选）

需要 Node.js 18 或更高版本。npm 包发布后，不需要先全局安装：

```bash
npx @ising-tech/isingq-mcp setup
npx @ising-tech/isingq-mcp configure-host --name generic --npx
```

把 `generic` 换成 `workbuddy`、`codex`、`claude-code`、`cursor` 或 `vscode`。默认跟随 npm `latest`；需要复现或回滚时可显式追加版本，例如 `@ising-tech/isingq-mcp@0.4.1`。需要手工导入时运行：

```bash
npx @ising-tech/isingq-mcp config --json --npx
```

用户手工运行时不加 `-y`，首次下载会显示 npm 确认提示。CLI 写入 Host 的持久 MCP 配置会自动使用 `npx -y`，避免 Agent 后台启动时卡在交互确认；这不会跳过 API Key 安全输入或求解确认。

### DeepSeek Harness 原生 Plugin

DSH `0.1.0-rc.7` 使用独立原生包，不需要再配置 `dsh-mcp-client`：

```bash
dsh plugin --profile web add @ising-tech/isingq-dsh-plugin
```

将 `web` 换成实际使用的 Profile。完全重启该 Profile 后，应看到 9 个 `isingq_*` 工具。原生 Plugin 与标准 MCP 共用本机 API Key 和求解记录；如果 Profile 已加载旧 MCP Bridge，应先确认迁移成功，再通过 DSH 官方 plugin 命令移除旧桥接配置。

### GitHub Release（无需 Node.js）

Release 安装会继续保留，支持 macOS arm64/x64、Linux arm64/x64 和 Windows x64。每个 Release 包含平台可执行文件、`manifest.json` 和可直接校验的 `SHA256SUMS`。公开 GitHub 仓库地址和签名公钥确定前，不提供 `curl | sh` 或 `irm | iex` 形式的远程执行命令；应从官方 Release 页面选择固定版本，核对清单后再运行可执行文件。这样不会把任意重定向后的脚本直接交给 shell。

### 本地源码（开发与审计）

克隆仓库后可以使用 Node.js 18 或更高版本安装：

```bash
cd /path/to/isingq-mcp
npm install -g .
isingq-mcp setup
```

`setup` 使用无回显输入保存 API Key。macOS/Linux 默认写入 `~/.config/isingq-mcp/api-key`，Windows 默认写入 `%LOCALAPPDATA%\isingq-mcp\api-key`。也可以由 Agent 的 secret 管理能力注入 `ISINGQ_API_KEY`；不要把 Key 写入 MCP 参数、Agent 配置或对话。

检查配置：

```bash
isingq-mcp self-check --json
```

只注册一个明确的 Host：

```bash
isingq-mcp configure-host --name workbuddy
```

`--name` 支持 `workbuddy`、`codex`、`claude-code`、`cursor`、`vscode` 和 `generic`。对于 Trae 或其他未提供稳定用户配置路径的 Host，运行 `isingq-mcp config --json`，再通过对应 Agent 的 MCP 设置导入。

通用 MCP 配置：

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

Codex CLI 也可以直接注册：

```bash
codex mcp add isingq -- isingq-mcp serve
```

WorkBuddy、Claude Code、Cursor、VS Code 等支持 stdio MCP 的 Host 使用相同的 `command/args`。完成后重启对应 Agent。

Windows 从源码安装：

```powershell
Set-Location C:\path\to\isingq-mcp
npm install -g .
isingq-mcp setup
isingq-mcp config --json
```

## 升级、重新安装与多 Agent

- 升级或修复安装时，重新让当前 Agent 执行 `install-isingq-mcp` Skill 即可。
- 已有 API Key 和本地求解记录会保留，不需要重复填写或迁移。
- 更新完成后必须完全退出并重启当前 Agent，才能重新加载 MCP 工具。
- 每台电脑只需要一份 `isingq-mcp` 可执行文件和一份个人 API Key。
- 同一台电脑使用多个 Agent 时，只需分别把同一个本地可执行文件注册到各 Agent，不需要重复安装程序。
- 不要修改 Agent 自动生成的代理、缓存、会话配置或运行时端口；MCP 注册应写入官方 MCP 设置或明确的用户源配置。

## QUBO 输入

MCP 接收稀疏 QUBO，目标函数约定为：

```text
offset + Σ linear[i]·x_i + Σ quadratic[i,j]·x_i·x_j
x_i ∈ {0,1}
```

示例：

```json
{
  "num_bits": 2,
  "linear": [
    {"index": 0, "coefficient": -1},
    {"index": 1, "coefficient": 2}
  ],
  "quadratic": [
    {"i": 0, "j": 1, "coefficient": -3}
  ],
  "offset": 4,
  "variables": [
    {"index": 0, "name": "choose_a", "meaning": "是否选择方案 A"},
    {"index": 1, "name": "choose_b", "meaning": "是否选择方案 B"}
  ]
}
```

MCP 会生成 upper-triangular CSV。`offset` 不写入矩阵，但会在结果中重新计算 `objective_value`；同时保留 IsingQ 返回的 `provider_energy`，避免混淆。

## 结果来源与限制

每条求解记录都返回：

- `solve_id`：用户电脑上的本地求解编号。
- `provenance.provider`：`北京伊辛智能科技有限公司`。
- `provenance.product`：`IsingQ`。
- `provenance.provider_task_id`：IsingQ 任务编号。
- `provenance.matrix_sha256`：本次 QUBO 矩阵摘要。
- `submitted_at`、`observed_at`、`completed_at`：提交、观察和完成时间。
- `limitations`：业务可行性、全局最优和硬件归因限制。

MCP 不会仅凭 `computer_type_id` 推断实际设备型号。只有 IsingQ API 明确返回并且调用契约已验证的设备信息，才适合进一步展示硬件归因。

## 安全边界

- API Key 只从本机私有文件或 `ISINGQ_API_KEY` 读取，不通过工具参数接收。
- 建模引导和 QUBO 校验完全本地执行。
- 只有 `isingq_solve_start` 会把生成的矩阵发送到 IsingQ。
- 矩阵通过 HTTPS 和 IsingQ 提供的上传链路发送。
- 获取 OSS 临时签名、创建任务和查询任务时才向 IsingQ API 发送个人 API Key；OSS 直传只使用 `policy`、`signature`、`security_token` 等短期签名字段，不携带个人 API Key。该边界已于 2026-08-18 通过 `useCredit=false` 的 2×2 QUBO 真实求解闭环验证。
- 本地记录只保存模型、任务 ID 和结果，不保存 API Key。
- 创建任务出现不确定结果时标记为 `submission_unknown`，不会自动重复提交。
- 本仓库及三个 npm 发布包采用 [Apache License 2.0](LICENSE)。该许可证允许商业使用、修改和分发，并包含明确的专利许可与免责声明；不授予 IsingQ 或伊辛智能相关商标权。

## 开发验证

```bash
npm test
npm run check
npm run build:binaries
```

`build:binaries` 会在 `dist/` 生成五个平台的独立可执行文件和带 SHA-256 的 `manifest.json`。也可以只构建一个 CI 矩阵目标，例如：

```bash
npm run build:binaries -- --target node22-win-x64
```

GitHub Actions 会在 macOS arm64/x64、Linux arm64/x64 和 Windows x64 原生 Runner 上分别构建，并用打包后的程序验证 MCP 的 7 个工具和 13 个 Resources。普通提交只保留 Workflow Artifacts；推送与 `package.json` 版本一致的 `v*` 标签时，才会汇总 SHA-256 并创建 GitHub Release。
