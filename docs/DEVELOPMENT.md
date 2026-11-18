# IsingQ Toolkit 开发者文档

本文档面向维护者和集成开发者。普通安装与使用请阅读根目录 [README](../README.md)。

## 安全运行与构建环境

运行最低版本为 Node.js 18.17。IsingQ HTTPS 链路显式使用固定运行依赖 `undici@6.29.1` 的 `fetch` / `FormData`，文件使用 `node:buffer` 的 `Blob`，不回退到全局 `fetch`。Core 和内嵌 core 源码的 MCP 都直接声明该依赖；DSH 通过 core 获取。依赖安装使用 `npm ci`，不要以更新 Host 的 Node.js 代替此运行依赖修复。

开发依赖中传统 pkg-fetch 路径单独锁定 `undici@7.30.1`。当前 `pkg --sea` 下载器仍使用 Node.js 内置 `fetch`，构建环境应使用包含上游修复的维护版本；本轮在 macOS arm64 上验证了 Node.js 24.22.2（内置 Undici 7.30.1）。可用 `node -p "JSON.stringify({node:process.version,undici:process.versions.undici})"` 核对实际构建进程。此边界与 Toolkit 请求链路分别验证。

`npm test` 包含公开 `IsingQTransport` 的真实 loopback 回归：6/7 层恶意编码及提前断连、正常 gzip、完整 multipart 上传、HTTP 错误脱敏、禁止重定向和请求超时。测试以独立子进程观察延迟的流错误；在旧 Node.js 22.22.2 上也须保持进程存活，无真实云端请求。精细合同单测拦截实际使用的 `undici.fetch` 模块属性，测试结束恢复，不能继续 mock 无关的 `global.fetch`。

最低兼容版本不等于所有运行时的安全认证。本修复只覆盖更新后的 Toolkit 请求链路，不修复其他全局 fetch 使用方、既有安装或历史可执行文件；Release 需重新构建并独立核对内嵌 Node.js 版本。

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
| `lhm.plugin.json` | LobeHub Marketplace 的完整技术能力与Resource展示快照，不替代普通MCP菜单 | `node scripts/generate-lhm-manifest.js` 生成，`--check` 校验；人工核对差异 |
| `server.json` | Official MCP Registry 元数据 | npm stdio 包 |
| `glama.json` | Glama 作者认领声明 | 不定义运行入口 |

外层和内层 `.codex-plugin` 不得互相引用资源文件。更新 Plugin 名称、描述、默认 Prompt 或 Logo 时应同步核对两份 manifest；更新 MCP 工具或 Resources 后应重新生成并检查 `lhm.plugin.json`。 快照跟随显式技术模式的完整公开能力，保留兼容工具及统一求解入口；普通 `serve` 仍按普通发现配置提供4个工具。生成与校验不读凭据、不查询设备或云，也不构成发布。

## MCP 与 Resources

0.9.x 标准 MCP 默认 `serve` 提供 4 个工具：`isingq_api_key_setup`、`isingq_knowledge_get`、`isingq_modeling_guide_get` 和 `isingq_solve`。显式 `serve --technical` 提供 20 个工具。DSH 原生 Plugin 提供 21 个工具（19 个共享 Core 工具及 `isingq_resource_list`、`isingq_resource_read`），不包含 MCP 的统一求解门面。13 个本地 Resources 覆盖公司、产品、技术、云平台、方案、案例、FAQ、术语、来源、QUBO 建模与数据流。

核对实际加载版本和入口，不用旧版数量判定新版本。共享 SDK 的完整 API 与数据约定见 [Core API](../packages/core/API.md)。

Resources 是版本化的本地公开知识，不在读取时访问远程网站。是否自动加入上下文由 Host 决定，关键行为必须由工具 schema 和运行时门禁保证。

## QUBO 数据契约

`linear`、`quadratic` 和 `variables` 为可选数组字段，省略或在 JavaScript 中传入 `undefined` 时按空数组处理。显式传入字符串、对象、`null`、数字或布尔值会立即报错，错误包含字段名和实际类型；不会静默丢弃字段或发起求解提交。空数组及合法数组仍沿用原有校验规则。

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

共享 core 根入口和 `/qubo` 子路径公开 `validateQubo`、`matrixDocument`、`modelDigest`、`objectiveEnergy`、`decodeBits`；专家 CLI 应复用这些函数，并检测 `QUBO_CONTRACT_VERSION === '1'` 和 `MODEL_DIGEST_VERSION === 'isingq-model-v1'`。`offset: null` 继续按 0 处理。

`isingq_qubo_validate` 直接调用 `SolverService.validate`，在原有矩阵信息之外返回 `model_sha256` 与 `model_digest_version`。完整模型摘要覆盖规范化系数、num_bits、offset 和变量映射，矩阵摘要继续只覆盖上传 CSV；既有 `request_digest` 和云端请求保持原定义。精确排序、显式零项、负零、字符串和黄金样例见 [QUBO 契约与摘要规范](../packages/core/MODEL-DIGEST.md)。

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

`isingq_solve_start` 先校验原始 `solver_options` 中显式的 `use_credit:boolean`（true=算力券，false=账户余额），再检查已有幂等记录；同 key 的模型和求解选项（含付款选择）必须一致。缺选择先询问，不得自动补 false 或切换付款。新请求在创建本地记录前读取并校验凭据，同次提交复用凭据快照。缺少或无效 Key 不占用幂等 key；旧 start 缺付款也拒绝，历史记录使用 poll/get 读取且不依赖 Key。直接 Transport.submit 同样在凭据与上传前拒绝缺付款。纯 validateSolverOptions 的默认兼容保持，不能作为付款授权。

公开 `CLOUD_SUBMISSION_CONTRACT_VERSION='isingq-cloud-submission-v1'` 与 `validateCloudSubmissionOptions(input)` 供其他入口复用；应传入未补默认付款的原始对象。HTTP 错误只按平台顶层 JSON message 解析，在实际 16 KiB 流式读取上限与 512 字符脱敏公开上限内保留诊断；不公开 HTML、堆栈或其他原始响应字段。诊断读取失败不改 HTTP 受理分类；安全 provider_message 随错误持久化，MCP/DSH 一致使用。公开记录包含 submission_outcome；旧记录无此信息时为 null。

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

文件容量开箱即用，不增加配置步骤或主动询问容量。默认与可选进程环境变量如下（单位均为 UTF-8 实际字节，包含 JSON 序列化和文件换行）：

| 用途 | 默认值 | 可选覆盖 |
|---|---|---|
| 单条求解历史记录读写 | 128 MiB / 134217728 bytes | `ISINGQ_MAX_RECORD_BYTES` |
| 本地模型/交付/报告文件导入、Workspace 文件读写 | 128 MiB / 134217728 bytes | `ISINGQ_MAX_LOCAL_FILE_BYTES` |
| Host JSON 配置读取与合并写入 | 10 MiB / 10485760 bytes | `ISINGQ_MAX_HOST_CONFIG_BYTES` |
| API Key 文件 | 64 KiB / 65536 bytes（含换行） | 固定，未提供覆盖 |

变量不存在即使用默认；存在时仅接受正十进制整数字节数，空值、0、负值、小数、科学计数、空格、单位后缀和超出当前 Node Buffer/string 可表示范围均报 `file_limit_invalid`，不静默忽略、不输出配置原文。实例构造时固定有效值；用户需要调整时让 Agent 在启动该进程时传入对应环境变量并重启，移除变量恢复默认。示例 `ISINGQ_MAX_RECORD_BYTES=268435456 isingq-mcp serve`；仅显式需要更大文件时使用，不是正常使用的前置步骤。工具不据此改写真实凭据或 Host 配置。

超过旧 4 MiB 而在有效上限内的历史可原样读取，无需迁移。`save/get/findByIdempotency/archive` 与 `start/poll/result_get` 共享有效上限，保留完整字段、同步占位和幂等检查；结构不完整的记录不跳过。`solve_record_too_large/invalid/unsafe/io_error` 区分容量、结构、路径与 IO，MCP/专家入口保留分类；超限包含实际 bytes、有效 max_bytes 与覆盖变量名，不误报损坏。超限及写入失败不替换原文件；本次创建的临时文件/Workspace 半成品清理，已存在产物仍拒绝覆盖。

内容导入与存储容量不是模型计算能力认证：QUBO 仍限 2048 位、上传 CSV 仍限 20 MiB；放宽文件不能解除这些契约。HTTP 成功 JSON 仍为 1 MiB、失败诊断为 16 KiB，按实际流式字节限制；未因本地文件扩容而放大。2048 位支持形状的合成响应已核验，真实平台极限响应规模尚未取得，不能宣称全部平台响应已覆盖。

共享容量实现为 `packages/core/src/file-limits.js`，专家 CLI 携带同内容副本并由跨仓回归锁定一致；输入 JSON、stdin、报告 export/check 不再绕过上限。core 标识 `FILE_LIMITS_CONTRACT_VERSION=isingq-file-limits-v1`；显式覆盖在不支持该契约的旧专家运行时上报错，不静默忽略。默认行为以本次候选源码为准，不代表旧安装已升级。

容量回归见 `test/file-limits.test.js` 与 `test/store-large-history.test.js`，容量与历史累积观测通过 `node scripts/benchmark-file-capacity.js` 执行。单次容量观测不是性能承诺；各次执行结果必须绑定对应源码或制品，旧固定上限阶段的结果不能替代整合候选验收。

`solve_start` 遇到无法恢复的失败或 `submission_unknown` 时，core 抛出包含公开求解记录的错误，MCP 返回 `ok: false`、`isError: true`，DSH 原生入口同样得到失败。`solve_poll` 和 `solve_result_get` 保持“调用是否成功”与“任务是否成功”分离：成功读取 `failed` 记录仍表示读取操作成功。

## 从源码运行本地候选

开发检查使用 ESLint 10；开发环境需 Node.js 20.19+、22.13+ 或 24+，不改变发行包的 Node.js 运行时声明。`npm run check` 遍历源码、测试与脚本进行语法检查，并执行 `npm run lint`（零警告）。根包、Core、DSH 的独立 `prepublishOnly` 均要求完整仓库的测试与共享检查。

ESLint 的 `quality/release-before-close` 拦截 close 后才清空 fd 所有权的重复缺陷；`quality/owned-lock-cleanup` 要求共享锁所有者统一核对本次 inode 再删除；`quality/no-throwing-fs-cleanup-in-finally` 通过实际 fs/owned-file 绑定及 FileHandle 的 open 来源，拦截 finally 中未保护的同步文件清理与异步 FileHandle.close；`no-unsafe-finally` 继续阻止显式控制流覆盖。规则不推断任意 callback 或 session.close 不会抛错。共享清理封装保存主错优先级（包括 throw undefined），逐项完成清理，无主错时报告首个清理失败。规则的非法/合法样例由 `test/lint-rules.test.js` 执行，实际 I/O 错误由对应故障注入回归验证。重复问题以可执行规则与用例控制，不以维护文字问题清单代替门禁。

MCP stdio 继续串行执行，输入按实际 UTF-8 字节在解析前限制，沿用 `ISINGQ_MAX_LOCAL_FILE_BYTES`（默认 128 MiB）；读取与输出写入均接受背压。文件分块核验仍走专用入口和独立预算。协议错误只影响当前消息；缺少 id 的通知不调用请求工具。

在官方源码目录中安装依赖，并生成指向当前检出的 stdio 配置：

```bash
npm ci
node bin/isingq-mcp.js config --json
```

将输出导入唯一目标 Host 的 MCP 设置，重连并核对实际加载版本与工具。该配置使用当前检出的绝对入口，不指向 npm 上的旧版本。仅本地求解无需运行 `setup` 或采集云端 API Key；云端凭据按 README 的安全输入流程按需配置。源码安装不会发布 npm 包。

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

### DSH 完整包验收

以下为维护者命令，在仓库根目录运行；验收脚本不随独立 DSH npm 包分发：

```bash
node scripts/verify-dsh-plugin.js \
  --host desktop --host-version 0.2.2-rc.1 \
  --dsh "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --plugin <plugin.tgz> --core <core.tgz> \
  --out /tmp/isingq-verify-desktop
```

脚本在隔离的 `DSH_HOME` 中安装打包后的 Plugin 与 Core，核对 21 个工具、13 个 Resources、本地冒烟结果、Core 来源与版本、宽限期内的 Host 存活及独立关闭快照。复制单个入口文件或 Host 退出前短暂调用成功不能替代完整包验收。兼容范围扩展前应在目标 Host 上重新执行此验收。

### MCP npm 包说明

仓库首页保留产品总览；MCP npm 包使用 `packages/mcp/README.md` 和 `README.en.md`，由独立打包入口带入归档根目录：

```bash
npm run pack:mcp
```

该命令按根包 `files` 清单在临时目录组装运行文件，只替换归档中的中英文 README，输出 `dist/ising-tech-isingq-mcp-<version>.tgz`。它不改写仓库首页，也不发布。可追加 `-- --pack-destination <目录>` 指定输出位置。

正式发布 MCP 时使用该命令生成的 `.tgz` 归档；直接从仓库根目录运行 `npm pack` 或 `npm publish` 仍会采用仓库首页。Core 与 DSH 继续使用各自包目录的 README 和原打包方式。

## GitHub Actions 与 Release

`.github/workflows/release.yml` 在 GitHub 官方原生 Runner 上分别构建五个平台，并使用打包后的程序验证MCP initialize、普通入口4个工具的确切名称及13个Resources。显式technical入口为20工具，原生DSH为21项；不同入口按各自契约检查，不复用旧数量。

- `main` 和 Pull Request：运行测试、构建和 smoke test，只生成 Workflow Artifacts。
- `dsh-latest`（建议性，`main` push 和手动触发）：用 `@deepseek-ai/dsh-tools@next` 在隔离目录运行 `scripts/smoke-dsh-plugin.js`，失败只告警，用于发现上游兼容性漂移。
- `v*` tag：要求 tag 版本与 `package.json` 一致，汇总产物后创建 GitHub Release。
- GitHub Actions 依赖固定到 commit SHA，升级时应核对官方 release tag 与对应 SHA。

正式发布顺序：

1. 更新三个 workspace 的同步版本。
2. 运行检查、测试和本地原生二进制 smoke test。
3. 推送代码并确认 `main` Workflow 通过。
4. 创建并推送对应 `v*` tag。
5. 确认五个平台产物、`manifest.json` 和 `SHA256SUMS` 已附加到 Release。
6. Release 验证通过后，再依次发布 Core、MCP 和 DSH npm 包；MCP 使用 `npm run pack:mcp` 生成的 `.tgz` 归档。

## 发布边界

- 不得提交 API Key、内部地址、内部仓库、测试账户或本地绝对路径。
- 不得把真实求解作为普通安装 smoke test。
- npm、Release 和源码安装必须复用同一 core 行为与安全门禁。
- 本仓库使用 Apache-2.0；许可证不授予公司或产品商标权。


## 后台版本检查与发布版本

后台版本提醒和显式 `update-check` 自 0.8.1 引入；当前 0.9.x 还包含求解目标接入与统一 MCP 门面。Toolkit 的检查本身不安装版本；专家托管工具的自动维护由专家兼容策略负责，不能与独立 MCP 的版本提醒混为一谈。

MCP serve和DSH apply启动inline后台管理器；专家普通validate/guide/knowledge由运行时启动detached worker。主任务不等待网络，成功结果仅从缓存消费可行动的update_notice；diagnose/setup/manualcheck不触发专家自动worker。worker最多5秒且环境白名单不继承API Key、npm令牌或NODE_OPTIONS；正常HTTP最多2秒/64KiB。

缓存位于用户缓存目录isingq-mcp/updates，成功24小时、失败5分钟，token锁防并发覆盖，通知按当前/最新版本对24小时去重。TTL不是自动轮询周期，长寿命服务需要显式手动刷新或在下次启动时检查。缓存异常不影响业务；off开关用于严格离线环境。Core纯数学函数不发请求。

发布前核对根包、Core、DSH 的 `package.json`、锁文件和 `server.json`；三个 Toolkit 包同步版本，当前源码为 0.9.0。按既定流程核对该提交 CI 及五平台 Release，再依次发布 Core、MCP、DSH。专家包使用自身版本和兼容工具约定，发布前确认所需 npm 运行时可获取。源码、安装包版本与 Host 实际加载版本分别核验，不能由源码候选推断已发布或已升级。
