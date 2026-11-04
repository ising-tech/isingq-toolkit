# @ising-tech/isingq-core

IsingQ 本地 Agent 集成的共享运行时，包含公开知识、QUBO 建模与校验、IsingQ HTTPS 调用、API Key 安全输入和本地求解记录。求解授权由 Agent 与 Host 负责；运行时不额外弹出操作系统求解确认框，也不验证不可伪造的人工授权记录与模型、参数的强绑定。

本项目提供辅助建模与声明范围内的确定性校验，不自动证明自然语言业务完整性或 QUBO 等价。云端求解器算法、解质量、耗时与返回方案属于外部服务；本项目维护工具接入、如实呈现返回与已有复算，不承诺全局最优或普遍性能优势。Host 后加的业务解释仍须单独核验。

该包不直接注册 MCP 或 DSH 工具，通常不需要最终用户单独安装。标准 MCP 使用 `@ising-tech/isingq-mcp`，DeepSeek Harness 使用 `@ising-tech/isingq-dsh-plugin`。

运行需要 Node.js 18.17 或更高版本。IsingQ HTTPS 链路使用固定运行依赖 `undici@6.29.1`，不使用 Node.js 内置 `fetch`。

## 共享 QUBO API

根入口和 `@ising-tech/isingq-core/qubo` 导出同一组函数，供 MCP、DSH 和专家 CLI 共用；不应在消费方复制 QUBO 校验规则。

```js
const {
  QUBO_CONTRACT_VERSION, MODEL_DIGEST_VERSION,
  validateQubo, matrixDocument, modelDigest, objectiveEnergy, decodeBits,
} = require('@ising-tech/isingq-core');

if (QUBO_CONTRACT_VERSION !== '1' || MODEL_DIGEST_VERSION !== 'isingq-model-v1') {
  throw new Error('当前 core 缺少所需的 QUBO 契约，请升级到支持该契约的版本');
}
const model = { num_bits: 2, linear: [{ index: 0, coefficient: -1 }], offset: null };
const { qubo, summary } = validateQubo(model);
const { model_sha256, model_digest_version } = modelDigest(model);
```

| API | 返回值与作用 |
| --- | --- |
| `validateQubo(input)` | `{ qubo, summary }`：共享五字段校验与归一化，summary 含完整模型摘要 |
| `modelDigest(input)` | `{ model_sha256, model_digest_version }`：先通过相同校验，再计算完整模型摘要 |
| `matrixDocument(input)` | 在校验结果上增加 CSV `content`、矩阵 `sha256` 和 `size_bytes` |
| `objectiveEnergy(input, bits)` | 重算含 offset 的 QUBO 目标值 |
| `decodeBits(input, bits)` | 按变量映射返回 bit、名称和含义 |
| `SolverService.validate(input)` | 平铺的 summary，加 `matrix_sha256`、`matrix_size_bytes`，与 MCP 校验响应 data 相同 |

输入只接受 `num_bits`、`linear`、`quadratic`、`offset`、`variables` 五个顶层字段。省略数组或传入 `undefined` 时默认为空数组，显式 `null` 数组报错；`offset` 省略、`undefined` 或 `null` 都按 0 处理。版本标识用于能力检测，消费方还应检查所需导出是否为函数；未暴露标识的旧版本不能推断为支持该契约。

完整模型摘要覆盖 num_bits、offset、系数与变量映射；矩阵摘要只覆盖 CSV。二者用途与精确序列化规则见 [QUBO 契约与完整模型摘要规范](MODEL-DIGEST.md)。这些本地 API 不访问网络、读取凭据或提交任务。

交互环境默认从用户私有配置文件读取 API Key。Headless 管理员可以在 Agent 进程启动前注入 `ISINGQ_API_KEY`；Agent 不得接收、设置或显示该变量。Toolkit 默认 Adapter 固定访问 `https://api.isingq.com`；显式构造 `IsingQTransport` 的嵌入式调用方自行提供 endpoint 和 API Key provider。

## 云提交与付款契约

根入口提供 `EFFECT_EVIDENCE_CONTRACT_VERSION='isingq-effect-evidence-v1'`。受信 Transport 的 `execution_mode` 声明 `simulation/live/unknown`；官方 Transport 明确为 live，未声明的自定义 Adapter 与历史无标识记录为 unknown，不从 task ID、前缀、路径或任意文本推断。新记录在提交前保存执行模式与 `billing`，start/poll/get、幂等命中及失败结果均保留；`provenance.source` 对应 simulation/isingq_api/unknown。simulation 的 `billing.status=not_applicable`；其余为 unverified。付款参数、计算次数与 succeeded 不证明扣费，当前无平台账单证据或账单查询能力。

`normalizeSetupResult(result)` 供 MCP、DSH 与 CLI 共用固定输出白名单；显式模式与字段矛盾时报错，缺模式降为 unknown，不推断 Key 存在或不存在。真实配置保留 configured/already_configured：`execution_mode=live`、`credential_effect=written/already_present`、`remote_verification=unverified`、`no_real_credentials=false`；written 仅在本次真实 saveApiKey 成功后产生，already_present 仅表示当前运行时已有配置，可能来自环境变量，不证明此前磁盘已有 Key。simulation 必须返回 `configured=false,status=simulation,execution_mode=simulation,credential_effect=not_written,remote_verification=not_applicable,no_real_credentials=true`，不可写真实或哨兵凭据后冒充用户真实配置。unknown 输出 `configured=false,status=unknown,credential_effect=unknown,remote_verification=unverified,no_real_credentials=null`，false 在此表示尚未证实配置，不能断言没有 Key。任何本地配置结果都不证明远端有效或鉴权成功。

`credential_presence` 是独立的存在性证据：simulation/unknown 必须为 `not_checked`，live 成功必须为 `available`，仅表示当前运行时配置可读取。`no_real_credentials=true` 兼容字段只限本操作未接触真实凭据，不等于用户全局没有 Key。不能从未检查/未写入/模拟结果推断缺 Key、只缺凭据或环境已齐备；available 也不证明远端有效。

根入口导出 `CLOUD_SUBMISSION_CONTRACT_VERSION='isingq-cloud-submission-v1'` 与 `validateCloudSubmissionOptions(input)`。提交前必须把原始 `solver_options` 交给该函数：要求对象自有的 `use_credit` 为 boolean，`true` 使用算力券，`false` 使用账户余额；其他五项沿用 `validateSolverOptions()` 的默认归一化与校验。缺少选择先询问用户，不得自动补 false 或切换付款。纯 `validateSolverOptions(undefined/null)` 的默认兼容仅供归一化，不表示用户授权付款。

`SolverService.start()` 和低层 `IsingQTransport.submit()` 都在读取凭据、保存记录和上传前校验显式付款选择。旧客户端的 `start` 省略付款也会被拒绝；读取历史记录使用 `poll/get`。相同幂等键绑定完整模型和求解参数（含付款选择），改变参数须重新确认并核查原任务，不得自动换键重提。HTTP400 的明确拒绝继续占位，受理不明继续阻止二次创建。

HTTP 错误只提取平台 JSON 顶层 `message`，脱敏后最多公开 512 字符；错误正文实际读取上限为 16 KiB，超过立即取消读取。HTML、堆栈、非 JSON、超限或读取失败时仅保留 HTTP/阶段等通用诊断，不把所有400解释成付款失败。安全诊断作为可选 `error.provider_message` 持久化，并由 MCP/DSH 共享；公开记录的 `submission_outcome` 标明 not_created/rejected/unknown/created（旧记录可能为 null）。诊断读取错误不会改变原 HTTP 受理分类。

## 本地交付校验与客观摘要

根入口新增 `DELIVERY_CONTRACT_VERSION='isingq-delivery-v1'`、`validateDelivery(document)` 和 `DeliveryValidationError`。MCP `isingq_delivery_validate`、DSH 同名工具和专家 CLI `delivery validate` 共用该函数；不构造 SolverService、不联网、不访问凭据、不读取引用、不运行测试或业务代码。

```js
const { validateDelivery } = require('@ising-tech/isingq-core');
const report = validateDelivery({
  qubo: { num_bits: 1, linear: [{ index: 0, coefficient: -3 }], offset: 5 },
  candidate_bits: [1],
  claimed_objective_value: 2,
  test_ledger: [{ id: 'energy', status: 'passed', evidence_ref: 'logs/energy.json' }],
});
```

输入仅允许 delivery_contract_version（可省略，存在时必须匹配）、qubo（必填）、candidate_bits、claimed_objective_value、mapping_completeness、test_ledger、claimed_summary、business_solution。candidate 可省略以支持提交前矩阵交付；存在时严格检查位数和数字 0/1，声明能量须包含 offset。mapping_completeness 缺省 partial；complete 仅在交付层要求全位映射，旧 validateQubo 仍接受 partial。

ledger 每条仅允许 id、status、result、evidence_ref；id trim 后唯一，重复拒绝，不去重。status/result 为 passed/failed/skipped/not_run，至少一个，两个同时提供须相同；evidence_ref 非空字符串或 null/缺省，仅统计有无。id 最大 200 字符、引用最大 4096 字符，不允许控制字符。供应 passed 不证明实际执行或证据真实。

返回 canonical_qubo（规整方向、去零、按索引排序）、candidate（或 null）、供应 test_ledger、summary、validation 和 limitations。summary 的支持字段也构成 claimed_summary 的精确白名单，允许部分声明，所有字段逐一严格比较，未知字段/冲突拒绝：

- num_bits、input_linear_terms、input_quadratic_terms（包含显式零的供应项数）。
- canonical_linear_terms、canonical_quadratic_terms、canonical_nonzero_terms（去零项数，后者为前两项之和）。
- named_variables、mapping_completeness（实际完整性）、offset、max_abs_coefficient（不含 offset）。
- matrix_sha256、matrix_size_bytes、model_sha256、model_digest_version（沿用旧摘要字节口径）。
- candidate_objective_value（沿用 shared 输入顺序计算，并核验 canonical 重排稳定性；无候选为 null）。
- test_records 对象仅支持 total、passed、failed、skipped、not_run、with_evidence_ref、without_evidence_ref。

validation.business_correctness 始终 unverified；ledger_authenticity 始终 not_verified。business_solution 的任意内容不校验生产 schema/业务可行性，提供时其 validation 状态为 unverified，否则 not_supplied。无执行真实性、模型业务等价或全局最优保证，不替代 Agent/Host 用户确认。

错误 code 为 delivery_invalid、delivery_unknown_field、delivery_mapping_incomplete、delivery_duplicate_test_id、delivery_claim_mismatch、delivery_numeric_instability，message 包含字段及必要 actual/expected 上下文。旧 QUBO 校验计数、matrix/model digest 保持原契约；云提交付款选择按上文显式契约执行。

候选能量同时比较输入顺序与 canonical 顺序的 shared objectiveEnergy；不一致或非有限时以 delivery_numeric_instability 拒绝当前数值精度，包含两个实际值，不误报用户声明错误，也不修改旧云能量算法。可调整系数量级/消去结构或使用可安全累加的整数系数后重验；简单整体缩放不保证恢复稳定，更不证明业务等价。

## 本地业务核验与报告（0.8.0 源码）

`validateMathModel`、`evaluateMathCandidate`、`compareMathCandidates` 复用有限数学模型契约；`buildVerifiedReport` 从同次核验生成目标分项、提供候选中的排名、基线改善与约束余量。CLI/MCP/DSH共享该核心，不按业务类型分支。不可行方案不入榜；取等不代表约束冗余；不推断全局最优、QUBO等价或实测收益。输入、错误与支持范围见 [VERIFIED-REPORT.md](VERIFIED-REPORT.md)。

此为源码变更，不表示已发布或已升级全局安装。本地报告不调用云求解、安装程序或凭据。


## 恢复合同（isingq-recovery-v1）

`SolverService.start/poll/get` 的公开记录带 `recovery` 与 `observation`。`same_key_retry_allowed` 与实际重试门禁同源，仅未创建且无任务证据的失败（含已知旧版上传失败）允许原模型/参数/键重试。unknown 保持阻止；rejected 原键占用，需修正原因并获得新任务确认。归档只是保留本地历史，不是远端取消或解除门禁。

幂等范围是 `local_store`，create_task 未传此键，远端去重 `unverified`。unknown/无远端ID/终态的 poll 与所有 get 只返回本地记录；本次实际发起远端 poll 才返回 `observation.remote_request_performed=true`（scope=status_query，仅指状态查询，不描述 start 的创建请求）。无远端ID时，用户可在平台控制台核对提交时段和模型，或向平台支持提供 created_at、matrix.sha256 及已有 provider_task_id；solve_id 只是本地关联号。当前无自动远端定位或解除 unknown 接口。费用仍以 billing 为准，unverified 不支持任何扣费保证。

报告输出 `evidence_boundary`（isingq-report-evidence-v1）明确数值核验只覆盖声明模型/数据/候选；不评估业务缺项，不认证额外自然语言解释。已给事实不能因该边界被重新列为缺失信息。

恢复的 `diagnostic_evidence` 明确 provider_message_present、provider_message_source 与 available_error_fields。没有字段只表示本记录未提供提示，不推断平台返回过脱敏文本；simulation提示只作模拟诊断，live为isingq_api，unknown来源未核实。phase/HTTP状态仍可用于定位阶段，缺根因时核对请求与接口要求或交维护者核查，不自动重提。

## QUBO输入与传输边界

共享QUBO_INPUT_SCHEMA用于guide.input_schema及工具参数：仅num_bits必填；linear/quadratic/variables省略为[]，offset省略或null为0。guide旧schema字段保留为示例，schema_role明确不是校验schema；normalized_output_fields表示完整规范化输出字段。数组null仍非法，默认值不改变既有校验。

规范化QUBO生成CSV上传，create_task只通过inputJFile引用矩阵并发送求解参数，不传原始QUBO JSON。省略与显式默认具有相同规范化模型、矩阵及请求摘要；上传生成的文件URL可不同，不代表语义变化。rejected动作改为diagnose_rejection：根因unverified，等价规范化不是修复，先诊断/人工核查。用户主动新任务的既有确认流程不变，不以此自动新建或重试。
