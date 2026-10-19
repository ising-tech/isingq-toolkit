# IsingQ Toolkit 开发者文档

本文档面向维护者和集成开发者。普通安装与使用请阅读根目录 [README](../README.md)。

## 仓库边界

该公开仓库提供本地 QUBO 建模与 IsingQ 求解工具，不包含内部建模系统、模型库、Case 服务、远端文件管理、用户认证或代理求解服务。

npm workspaces 包含三个发布单元：

- `@ising-tech/isingq-core`：QUBO、知识、IsingQ HTTPS、API Key 安全输入和本地记录逻辑；求解授权由 Agent 与 Host 负责。
- `@ising-tech/isingq-mcp`：标准 stdio MCP、CLI 和 Codex Plugin 入口。
- `@ising-tech/isingq-dsh-plugin`：复用 core 的 DSH 进程内原生适配器。

三个包同步版本。DSH 原生 Plugin 与标准 MCP 不应在同一 Profile 中同时启用。

## 分发目录

仓库同时服务 npm、Codex Repo Marketplace、LobeHub、Official MCP Registry 和 Glama。以下文件名称相近，但职责不同：

| 路径 | 职责 | 运行入口 |
| --- | --- | --- |
| `.codex-plugin/plugin.json` + `.mcp.json` | npm/source Codex Plugin；随 `@ising-tech/isingq-mcp` 打包 | 仓库或 npm 包内的 `bin/isingq-mcp.js` |
| `.agents/plugins/marketplace.json` | Codex Repo Marketplace 目录，只声明可安装项与策略 | 指向 `plugins/isingq-mcp/` |
| `plugins/isingq-mcp/` | Repo Marketplace 的轻量包装和展示素材 | `npx -y @ising-tech/isingq-mcp serve` |
| `lhm.plugin.json` | LobeHub Marketplace 的工具、Resource 与展示快照 | 发布前由本地源码 MCP 重新生成并人工核对 |
| `server.json` | Official MCP Registry 元数据 | npm stdio 包 |
| `glama.json` | Glama 作者认领声明 | 不定义运行入口 |

外层和内层 `.codex-plugin` 不得互相引用资源文件。更新 Plugin 名称、描述、默认 Prompt 或 Logo 时应同步核对两份 manifest；更新 MCP 工具或 Resources 后应重新生成并检查 `lhm.plugin.json`。

## MCP 与 Resources

标准 MCP 暴露 7 个工具；DSH 原生 Plugin 额外提供 `isingq_resource_list` 和 `isingq_resource_read`。13 个本地 Resources 覆盖公司、产品、技术、云平台、方案、案例、FAQ、术语、来源、QUBO 建模与数据流。

Resources 是版本化的本地公开知识，不在读取时访问远程网站。是否自动加入上下文由 Host 决定，关键行为必须由工具 schema 和运行时门禁保证。

## QUBO 数据契约

目标函数：

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

MCP 生成 upper-triangular CSV。`offset` 不写入矩阵，但用于重新计算 `objective_value`。结果同时保留 IsingQ 返回的 `provider_energy`。

## 结果来源

每条本地求解记录包含：

- 本地 `solve_id`。
- IsingQ provider、product 和 provider task ID。
- QUBO 矩阵 SHA-256。
- 提交、观察和完成时间。
- 业务可行性、全局最优和硬件归因限制。

不得仅凭 `computer_type_id` 推断实际设备型号。只有 API 明确返回且调用契约已经验证的设备信息才能用于硬件归因。

## 数据流与失败语义

- 交互环境默认从本机私有文件读取 API Key；Headless 管理员可在 Agent 进程启动前注入 `ISINGQ_API_KEY`，运行时不持久化该变量。Agent 不得接收、设置或显示 Key。
- Toolkit 默认 Adapter 固定访问 `https://api.isingq.com`，不支持运行时 `ISINGQ_BASE_URL`。测试或嵌入式调用方可以显式构造 Transport，并自行提供 endpoint 与 API Key provider。
- `ISINGQ_TIMEOUT_SECONDS` 只调整请求超时，不改变目标域名或凭据边界。
- 获取临时签名、创建任务和查询任务时，个人 API Key 发送给 IsingQ HTTPS API。
- OSS 上传只使用短期 `policy`、`signature` 和 `security_token`，不携带个人 API Key。
- 创建任务出现不确定结果时标记为 `submission_unknown`，不得自动重复提交。

### 幂等提交与恢复

`isingq_solve_start` 先检查已有幂等记录；同 key 的模型和求解选项必须一致。新请求在创建本地记录前读取并校验凭据，同次提交复用凭据快照。缺少或无效 Key 不占用幂等 key；已有有效记录的读取不依赖当前是否配置 Key。

是否允许再次创建远端任务，由 Transport 提供的明确提交结果决定，不能仅凭异常类名、`retryable` 或 `failed` 状态推断：

| 失败位置或已有状态 | 同 key 再次提交 |
| --- | --- |
| 获取签名、上传矩阵等创建任务之前的失败 | 确认未创建任务后允许；归档原失败记录并创建新尝试 |
| 创建任务请求后发生网络、响应读取或解析异常，无法确认 task ID | 保留 `submission_unknown`，阻止再次创建 |
| 已有远端 task ID，后续求解或轮询失败 | 保留原任务，阻止再次创建 |
| 正在提交、已提交、运行中或已成功 | 返回原记录，不重复创建 |

Transport 的同步 `prepareSubmission()` 返回仅供本次 `submit(matrix, options, credentials)` 使用的凭据快照，不写入求解记录。`IsingQError.submissionOutcome` 区分 `not_created`、`unknown` 和明确拒绝的 `rejected`；本地记录用 `submission_outcome` 保存该结果，成功时为 `created`。自定义 Transport 可继续只实现原有 `submit` 接口，但未明确分类的异常按提交结果未知处理，不能自动重提。

归档记录保留诊断信息；归档持久化失败时中止本次重试并报错。升级前的失败记录仅在已有阶段信息足以证明尚未创建任务时允许恢复；`phase: submit`、空 task ID 等信息本身不足以证明安全，需要人工核查云端任务。

本地求解记录（含归档）超过 10000 条时停止提交，并提示目录、实际数量与备份整理建议；不会通过截断扫描来判断幂等 key 不存在。

`solve_start` 遇到无法恢复的失败或 `submission_unknown` 时，core 抛出包含公开求解记录的错误，MCP 返回 `ok: false`、`isError: true`，DSH 原生入口同样得到失败。`solve_poll` 和 `solve_result_get` 保持“调用是否成功”与“任务是否成功”分离：成功读取 `failed` 记录仍表示读取操作成功。

## 本地验证

```bash
npm ci
npm run check
npm test
```

完整跨平台构建：

```bash
npm run build:binaries
```

单个平台构建：

```bash
npm run build:binaries -- --target node22-win-x64
```

支持的 target：

- `node22-macos-arm64`
- `node22-macos-x64`
- `node22-linux-arm64`
- `node22-linux-x64`
- `node22-win-x64`

产物位于 `dist/`，包含平台程序、`manifest.json` 和 `SHA256SUMS`。

## GitHub Actions 与 Release

`.github/workflows/release.yml` 在 GitHub 官方原生 Runner 上分别构建五个平台，并使用打包后的程序验证 MCP `initialize`、7 个工具和 13 个 Resources。

- `main` 和 Pull Request：运行测试、构建和 smoke test，只生成 Workflow Artifacts。
- `v*` tag：要求 tag 版本与 `package.json` 一致，汇总产物后创建 GitHub Release。
- GitHub Actions 依赖固定到 commit SHA，升级时应核对官方 release tag 与对应 SHA。

正式发布顺序：

1. 更新三个 workspace 的同步版本。
2. 运行检查、测试和本地原生二进制 smoke test。
3. 推送代码并确认 `main` Workflow 通过。
4. 创建并推送对应 `v*` tag。
5. 确认五个平台产物、`manifest.json` 和 `SHA256SUMS` 已附加到 Release。
6. Release 验证通过后，再依次发布 core、MCP 和 DSH npm 包。

## 发布边界

- 不得提交 API Key、内部地址、内部仓库、测试账户或本地绝对路径。
- 不得把真实求解作为普通安装 smoke test。
- npm、Release 和源码安装必须复用同一 core 行为与安全门禁。
- 本仓库使用 Apache-2.0；许可证不授予公司或产品商标权。
