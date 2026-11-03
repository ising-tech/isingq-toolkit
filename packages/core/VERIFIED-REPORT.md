# 有限整数候选核验与确定性报告

本模块离线复算调用方明确提供的数学模型、数据和候选，不求解、不枚举、不运行输入代码、不调用云。`delivery.js` 的 QUBO 核验语义保持不变；本模块不宣称通用 QUBO 编译已完成。

## 公共 API

从 `@ising-tech/isingq-core` 根入口导出：

- `MATH_MODEL_CONTRACT_VERSION = 'math-model-v1'`
- `validateMathModel(model, data)`：解析并验证冻结的 math-model-v1，返回已解析的 `variables`（ID → `[lower,upper]`）、`sense`、`objective`、`constraints`。
- `evaluateMathCandidate(model, data, assignment)`：返回 `status`、`objective_value`、`violations`、`verification_scope='declared_finite_integer_model'`，另附 `variable_diagnostics`、`constraint_diagnostics` 和 `objective_breakdown`。
- `compareMathCandidates(model, data, baseline, candidate)`：只有两者都可行才返回 `status='comparable'`、按 min/max 方向计算的 `absolute_improvement`。仅正目标基线产生精确百分比分数 `{numerator:100*改善值,denominator:基线目标值}`；非正基线百分比为 `null`。不可行返回 `not_comparable`，没有改善数字。
- `VERIFIED_REPORT_CONTRACT_VERSION = 'isingq-verified-report-v1'`
- `buildVerifiedReport(document)`：重新核验全部候选，原子生成结构化结果与 `report_markdown`。
- `MathModelError`、`VerifiedReportError extends MathModelError`：均含 `code`、`path` 和可读 `message`；构造签名 `(code,path,message)`。报告调用统一抛 `VerifiedReportError`。

## 数学输入边界

`model` 仅接受 `schema_version/id/variables/objective/constraints` 与可选 `label`。变量仅支持 binary 和带有限闭区间上下界的 integer。scalar 为安全整数或精确单键对象 `{"param":"flat_key"}`；`data` 为平坦安全整数对象，缺失及未引用的参数都拒绝。目标支持常数、线性及二次显式项；约束支持仿射表达式和 `le/ge/eq`，不支持容差或严格不等式。标签只作文本展示。

表达式仅有可选 `constant` 和必需 `terms`；term 仅有 `coefficient/variables`。变量及约束 ID 在各自空间唯一；候选是变量 ID 到安全整数的完整精确映射。缺项、多项、非整数是输入错误；域越界是不可行，但仍复算全部目标和约束。

限制与冻结 Python 原型一致：256 个变量、1024 条约束、全模型 20000 项。所有乘法、累加、域宽、残差、改善及百分比分子逐步使用精确整数运算检查 ±(2^53−1) 边界；超界 `unsupported_numeric`，从不返回部分通过/部分不可行。错误另含 `input_error/unsupported/unsupported_size`。对象/数组必须为 JSON 数据形态，拒绝稀疏数组、自定义数组 prototype、额外字段、继承对象、accessor 和 symbol 字段；非法整数值的诊断只读取安全的类型描述，不调用对象或函数的转换 hook。JS 的 `1` 与 `1.0` 解析后同为安全整数；无法在对象 API 中区分原始 JSON 拼写。原始 JSON 重复键也须由载入层拦截，解析后对象不保留此信息。专家 CLI `report verify --file` 在进入 core 前拒绝所有层级的重复对象键，含 Unicode 转义解码后同名键，返回不回显原文的 `report_file_invalid`。MCP/DSH 的已解析对象接口无法恢复先前被覆盖的键，raw JSON 载入方必须承担该检查；旧 delivery 与 JSONRPC 解析语义不变。

`constraint_diagnostics` 每条记录均含 `id`、可选 `label`、`lhs/rhs/relation/slack/active/violation`。`le` 余量为 rhs−lhs；`ge` 为 lhs−rhs；`eq` 为 −|lhs−rhs|。`active` **只**表示 lhs=rhs；即便某约束取等，也不能由此推导边际价值、放宽效果或冗余。`objective_breakdown` 含常数、每项的系数/变量/变量值/分项值及总值。变量记录含声明域、上下界、实际值及 `within_domain`。

## 报告输入与输出

输入必须且仅能包含：

```json
{
  "report_contract_version": "isingq-verified-report-v1",
  "model": {
    "schema_version": "math-model-v1", "id": "example",
    "variables": [{"id":"x","domain":"binary"}],
    "objective": {"sense":"min","expression":{"terms":[{"coefficient":1,"variables":["x"]}]}},
    "constraints": []
  },
  "data": {},
  "candidates": [{"id":"a","assignment":{"x":0}}],
  "baseline": {"x":1},
  "top_k": 1
}
```

`baseline` 和 `top_k` 可选；baseline 是同一模型/数据的完整赋值，`top_k` 为正安全整数。候选 ID 唯一。未知字段、调用方已算好的目标/排名/核验状态/报告对象均拒绝；候选名中的 feasible/optimal 等字符串不具有权威性。

输出：

- `scope='provided_candidates'`、`model_id`、`objective_sense`。
- `input_digests`：SHA-256 绑定 model、data、两者组合、候选列表、可选基线和整个 document。`encoding='sorted_object_keys_json_v1'`：对象键按 JavaScript 字符串顺序排序，数组顺序保留，使用 JSON 字节 UTF-8 编码。该摘要描述输入身份，包含 ID/label，不声称数学等价；不是 Python 原型跨语言摘要契约。
- `baseline`：可选基线的 `assignment_sha256/model_data_sha256/verification`；无基线时 `null`。
- `candidates`：按输入次序保留每个候选的 `id/assignment_sha256/model_data_sha256/verification/baseline_comparison`。无基线时 comparison 为 `null`。每条候选与基线摘要都能与同一模型数据绑定。
- `ranking`：只含可行候选的 `{rank,id,objective_value}`，按目标方向排序；同值同 rank（competition rank，例如 1/1/3），并列以 ID 的固定字符串顺序稳定排列。`top_k` 按候选位置截断，边界全部并列均保留。
- `selection`：`top_k`（未提供为 null）、`provided_count/feasible_count/infeasible_count/returned_count/boundary_ties_included`；空列表合法，不能产生排名。
- `report_markdown`：从上述计算结果直接渲染，列出候选排名/目标分项/变量域/每条约束的实际值、余量、取等与违反量。标签仅作 HTML/Markdown 转义后的文本；调用方不能传入报告片段。基线不可行时不展示改善值，非正基线不制造百分比。

报告不证明所给候选之外的最优性、自然语言需求完整性、QUBO 等价性或实际收益，也不推断约束冗余、影子价格。无时间戳或随机字段；同一输入重复输出确定。任意候选或基线诊断/比较发生溢出时整个报告失败。

## 验收语料

`test/fixtures/math-model-v1` 是冻结设计原型六类案例的原样 JSON 快照，覆盖 assignment/facility/flow/inventory/maxcut/selection；统一 runner 不按业务 ID 分支，expected 为独立预置答案。生产实现不引用该语料路径。新增边界测试覆盖并列截断、漏候选错误排名、不可行低目标、正/零/负/不可行基线、原子溢出、输入严格性和摘要变化。


## 确定性报告文件绑定（isingq-report-artifact-v1）

沿用既有renderer的完整变量域/赋值、目标分项、约束和排名表，不另造一套业务赋值。report_markdown增加document_sha256输入绑定行；report_artifact返回renderer_version、UTF-8字节SHA256、size_bytes及input_document_sha256。字节摘要与原有排序JSON input_digests的编码不同，不混用。

公开verifyReportArtifact(document, content)从真实数学输入重新调用buildVerifiedReport，完成数学复算，再将content的实际字节与本次确定性report_markdown比较；不接受外部report对象、自报hash或receipt作为核验依据，不解析自由Markdown推定数学正确。不同输入、改变量/数字/标签、增删正文或复制时额外换行都会导致report_artifact_mismatch；同一JSON对象键顺序不改变规范化输入摘要。成功只表示此刻的字节与受检输入的规范报告一致，不认证另外的说明或后续修改。

MCP isingq_report_verify保持只读，无文件写入参数，input.document仍仅为数学输入，不包含任意业务Markdown。专家CLI新增report export/check，见专家合同；export显式复用WorkspaceArtifacts.write独占创建，check通过受限read读取实际路径。默认verify不写文件。


## 同源可见摘要

visible_summary以显式字段区分counts.provided/feasible（unit=candidate）与best_candidates.objective（unit=model_objective_unit_unspecified）；仅按送检集合计数，不认证穷举总数或分支总数。未在数学输入中声明目标单位时不猜测元/人时等业务单位；情景名称与变量含义复用已有model.label/变量label。基线改善仅复用同模型已可比的baseline_comparison，不新增跨场景差额/百分比结论。

visible_summary_markdown在同一report生成过程中生成一次并原样嵌入report_markdown，完整赋值表复用既有renderVariables；没有第二套决策计算。report_artifact另含visible_summary_sha256。最终聊天可原样引用该段，按各自model/input_digests并列不同情景；不能把目标值改述成方案个数，不能把未送检分支统计或人工跨场景汇总冠以工具认证。文件check只核对实际文件，不窥探或认证任意最终聊天是否遵循这些规则；Host遵守仍需独立验收。


## 可引用推荐依据

visible_summary.best_candidates[*].recommendation_basis直接引用同次候选verification的objective_breakdown/constraint_diagnostics/status、实际ranking.rank与selection.feasible_count，并绑定assignment_sha256和input_document_sha256。摘要内的推荐依据只说明满足已声明模型约束、目标分项构成、在送检可行候选中的排名；同一次renderObjective/renderConstraints同时服务摘要和完整报告，未增加独立数值算法。renderer_version为isingq-report-markdown-v3。

这些字段不包含变量频次、必要性、稳健性或敏感性结论；不能由当前候选的可行性/取等状态推导这些命题。新增量化解释须另有可复核数据来源与覆盖范围，不冒充既有recommendation_basis。包内补齐依据供给仍无法强制Host不在摘要后自由续写；file check只验证文件字节，不是聊天显示前门禁。无Host/hooks/全局配置变更。
