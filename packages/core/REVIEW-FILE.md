# 文件分块核验

`isingq-review-file-v1` 为较大的原业务模型提供文件入口。普通 MCP 仍使用 `isingq_solve`；聊天确认、所选求解器和原任务关联保持原有流程。小模型的内联 `review` 继续兼容。

## 容量依据

4095 个变量的完整上三角二次模型含 `4095 × 4096 / 2 = 8,386,560` 个独立项。以原位 ID `x_0…x_4094`、安全整数最大负系数及每项一个分隔符保守计量，每项最多66字节，目标项预算553,512,960字节。预留至少50%附加数据空间后向上取2的整数幂，默认聚合输入预算为 **1 GiB**。`verificationCapacityBasis()` 返回计算依据。

这个基准覆盖规范化满矩阵的数值表示，余量供变量、参数、约束和映射使用；4095不能推导任意数量约束、重复项或无限说明文字的数学最大值。进程可用 `ISINGQ_MAX_VERIFICATION_INPUT_BYTES` 指定正安全整数字节；这不是预分配内存或运行性能承诺。可信SDK调用者可用 `referenceBits` 提供更大实际模型维度，默认预算相应扩大；MCP从原保存任务取维度，不接受文件自报维度来提高资源预算。

核验预算与设备规则分别负责不同对象。云端维度、问题类型、计算次数、后处理、CSV上限及NPZ选择继续依据当前目录接口；本地核验预算不覆盖或放宽这些限制。记录文件、矩阵文件和核验输入也不共用容量设置。

## 建模代码导出

```js
const { writeMathModelReviewFile } = require('@ising-tech/isingq-core');

const fileRef = await writeMathModelReviewFile({
  directory: workspaceRoot,       // 已存在的明确工作目录
  qubo: originalQubo,              // 程序自动绑定原模型摘要
  model: {
    ...originalModel,
    objective: {
      sense: originalModel.objective.sense,
      expression: { terms: originalObjectiveTerms() }
    },
    constraints: originalConstraints()
  },
  data: originalData,
  baseline: originalBaseline       // 可选，同一模型的参考赋值
});
```

`terms` 与 `constraints` 可由可信建模程序提供同步／异步迭代器，避免生成整个大数组。生成器仅在建模进程内运行，不作为MCP参数或文件内容执行。数学表达式仍是原来的有限整数、二次目标与仿射约束，不按业务题型分支。

返回值只有 `{manifest_path, content_digest}`，其中摘要为清单实际字节SHA256。原QUBO已在其他地方绑定时可传 `qubo_model_sha256` 代替 `qubo`，二者互斥。整数编码可提供原 `bindings`，映射系数必须为整数常量，引用为原位 `x_0` 等；实际范围在读取原任务时核对。导出使用新目录和新文件，失败清理本次目录，不覆盖已有产物。

## 普通MCP续接

建模／准备时把回执放入 `review_file`：

```json
{"action":"prepare","qubo":"此处实际提供原QUBO对象","problem_summary":"原业务问题","review_file":{"manifest_path":"运行主机上的实际清单绝对路径","content_digest":"导出回执中的实际SHA256"}}
```

上例仅说明字段位置，不是可直接执行的参数。后续确认和状态操作沿返回的现成调用；到候选结果时，复核调用自动携带同一个文件引用，不让用户再次选择是否解读、抄写摘要或填写协议。

已有保存任务可用 `action:'review'`、原 `solve_id` 和 `review_file` 复核。`review_file` 与内联 `review` 互斥；原请求已绑定文件时不能替换成另一份来源。文件必须绑定原QUBO摘要；该绑定和数值核验不证明自然语言需求或QUBO与业务公式完全等价。

SDK可直接使用：

```js
const { verifyMathModelFile } = require('@ising-tech/isingq-core');
const result = await verifyMathModelFile(fileRef, {
  assignment: originalCandidate,
  outputDirectory: privateOutputDirectory
});
```

普通MCP不会接受调用者填写候选赋值：它仅从本次保存记录提取原位，解码原映射，再复用同一整数乘加、变量域、约束诊断及基线比较。`assignment` 是直接SDK接口的可信输入，不是普通MCP字段。

## 文件格式与完整性

导出器生成清单、目标项JSONL及约束JSONL。文件是UTF-8紧凑JSON，不允许重复键或非规范数字／转义写法；每条记录一行，LF分隔，最后一行可不带LF。清单的 `schema_version` 为 `isingq-review-file-v1`；内部数学契约仍为 `math-model-v1`。

表达式可使用原 `terms` 数组，或互斥的 `terms_file:{path,sha256}`。每项为 `{coefficient,variables}` 或互斥的 `{coefficient,indices}`；后者按清单变量声明顺序索引，原编码映射中的索引则是原位序号。导出器默认使用数值索引，避免重复的长业务ID膨胀系数文件；变量ID与业务含义保留在清单中，不改名、不改变项顺序或数值。模型提供完整 `constraints` 或互斥的 `constraints_file`；无额外约束明确使用空数组或空的约束文件。参数与可选基线在清单中，原编码映射可用内联或文件表达式。

文件项的参数系数还可使用 `{param_index:i}`，按清单 `data` 的JavaScript `Object.keys`顺序对应原参数名；导出器自动处理，参数名和值完整保留，运算仍通过同一个参数解析器执行。源映射仍只接受整数常量系数。数值索引使正常导出数据不因长变量名或长参数名在每项重复而膨胀；头部资料仍计入聚合预算。

清单属于文件容器；含 `terms_file/constraints_file` 的结构不能当作普通内联模型传给旧接口。旧接口会拒绝这些字段，避免把缺失表达式当成零。

引用只能在清单目录内，禁止绝对引用、上级目录、符号链接及引用循环。逐块读取时累计实际输入字节，检查文件类型、身份、读取期间变化与完整SHA256。无效内容不回显到错误信息。重复使用同一文件按每次实际消费计量；原位代入不另生成需重复计量的临时模型。

64 KiB是I/O缓冲块大小，不是模型容量限制。目标项逐条验证，非法系数即便乘到零也拒绝；中间溢出后再抵消仍拒绝。清单元数据和单条JSON记录仍受运行时单字符串能力约束；大表达式、约束应拆到文件，而不是塞进一条记录。

## 结果及失败行为

全部变量域和全部约束先核验，文件方式的响应只返回最多40条变量／约束展示行，并给出实际 `decision_count/constraint_count`；末位失败优先显示。完整变量及约束诊断写到新的 `checks.jsonl`，返回 `complete_diagnostics` 文件引用与实际摘要。大型目标保留原项文件、已核对摘要、实际项数和候选绑定，不额外生成巨大的逐项Markdown。来源以内容摘要绑定；同一份清单及数据移动目录后可沿原内容摘要复核，不把位置变化误作模型变化。

文件核验会创建新核验产物；不写回原模型、原任务或候选，不查询设备、读取云凭据、上传或创建新求解。输入超限、摘要不符、源文件变化、非法数学或产物写入失败时不返回部分通过；清理本次未完成产物，保留原任务和输入。调整资源或从原模型重新导出后可继续复核同一笔候选，不重新提交。

`node --max-old-space-size=256 scripts/benchmark-review-file.js 4095` 可在仓库内生成实际满密度文件并离线核验。脚本检查全部8,386,560项、4095个变量及约束，使用最大安全整数系数；它不访问设备，不消耗余额或算力券，结束后清理大文件。数学容量验证不等于设备精度无损、全局最优或全部Host端到端通过。

同一Node运行时一次只执行一份文件核验；不同Core副本／热更新共享同一运行槽。重叠调用返回 `review_file_busy`，普通MCP投影为 `reviewing/pending` 并提供原复核操作，不重复读大文件、不返回可行性结论，也不发起新求解。Host等待当前工作结束后继续，不能密集重试或要求用户重新确认。异常和完成均释放运行槽；独立Node进程各自管理资源。
