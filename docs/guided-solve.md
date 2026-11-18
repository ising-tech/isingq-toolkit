# 业务求解门面（开发候选）

Core公开`GUIDED_SOLVE_CONTRACT_VERSION='isingq-guided-solve-v1'`与`service.guideSolve(args)`；MCP为`isingq_solve`。该候选未发布，也不自动替换已有安装或用户技能。

普通`serve`仅发现安全配置、公开知识、短建模引导和统一求解四个工具；初始化与建模／数据流资源使用普通业务说明。`serve --technical`或`createHandler(service,{tools_profile:'technical'})`显式发现完整技术工具和资源。既有技术工具的显式调用仍保留，原始Core目标API及记录不变。

| action | 业务输入 | 行为 |
| --- | --- | --- |
| model | qubo、problem_summary；可选model_markdown业务说明 | 仅本机校验与导出，不读取目录／设备／凭据，不联网或创建任务 |
| prepare | qubo、problem_summary；可选model_markdown和preferred_target设备名；已有模型沿现成call | 持久保存当前模型和变量含义，准备摘要，不提交 |
| choose | request_id；可选target_id | 无目标标识时仅查看完整选项，保留原选择；提供选项标识后才改选 |
| funding | request_id、payment=credits或balance | 仅付费云目标明确选择付款来源 |
| confirm | 直接使用当前现成call（含request_id及confirmation_ref） | 仅使用Core保存的计划；依据变化先返回新摘要，等待新的确认 |
| status | request_id或solve_id二选一 | 查询原任务，不重新提交 |
| review | request_id或solve_id二选一；可选review业务核验信息 | 仅读原任务候选，解码并复用既有数学报告核验；不查询设备、不上传、不创建任务 |
| history | 可选limit、offset | 按每笔原来源分页查看 |
| manage | 可选request_id | 打开原有连接管理页，不创建求解任务 |
| refresh | request_id | 保留模型与合法选择，刷新可用性及当前摘要 |
| cancel | request_id | 仅停止提交前准备，不等于远程任务取消 |

正常首次建模／准备返回`modeling`建模产物段与完整程序求解呈现`reply`及`actions`。普通出口不再重复返回可被自由拼装的summary对象；内部摘要仍用于生成reply与确认绑定。应呈现变量、业务目标、约束、公式及实际文件入口，不能把正常回复压成纯求解摘要。`modeling`含status、markdown、files（label/path）、files_markdown、location、note；纯status可仅返回files_only，不用“已展示”标记推断用户看过。每项为`{label,call:{tool:"isingq_solve",arguments:{...}}}`；控制关联只在现成调用参数内，不作为顶层用户摘要字段。提交前prepare返回后，Host先完成用户已经明确的业务选择：选项与用户给出的名称和来源无歧义相符时，沿该项现成call继续准备，不要求重复选择；已有明确付款选择同样复用，不代选资金或擅自改变目标。选择不等于提交。仅在真正缺少目标／付款选择、硬性阻断或ready等待本次执行明确确认时，呈现reply和全部业务label并等待用户；执行对应现成call，不重建关联，也不把call当作已获授权。业务状态、就绪或具体阻断原因、模型规模、实际目标、数据去向及资源影响仍可核对；目标／付款选项也有现成调用。提交后返回原目标、任务号与已核实查看入口；候选返回bits、变量映射与含offset的原QUBO目标值，仍须按业务约束核验。设备内部处理、最优性和扣费不能从任务成功推断。

Core在私有记录中持有完整业务摘要、模型、变量映射、目标、参数、准备依据及稳定幂等标识。短reply不照抄传入的长摘要或系数／能量推断，只呈现程序已知的本步事实；业务目标与约束由Host保留原建模上下文。普通调用不接受这些技术参数的注入。确认回放、重启或受理未知均沿原记录，不能换键重提；其他新请求也受原目标引擎的模型占用规则保护。确认call还绑定当前内容及阶段版本；选择目标／付款或实际准备依据变化会撤销或更新版本，旧call不能被最新准备内容静默升级。相同版本已提交的回放只读同一原记录。普通容量事实来自当次设备／目录及明确部署范围，未知如实未知，不从名称推规模或增加内部精度门槛。确认动作必须来自Host本次实际用户确认；不透明请求标识只关联内容，不证明人工授权。

选择阶段保留全部目标；每个`targets[].guidance`投影当前实际变量数、已声明规模范围、原目录建议及匹配依据，`suggestions`同时用于程序生成的中文`reply`。能力未声明或建议不可用如实标为未核实；未被推荐的选项仍可选择，独立准备检查继续拦截硬性不适配。选定后仅呈现该目标的现有准备建议，不增加接受建议步骤、不改变参数或目标，也不为建议额外读取目录／设备；建议正文不参与确认版本绑定。

云端普通调用使用当前公开目录及生产环境，次数为1；明确固定处理要求优先，否则使用产品默认处理。付款不代选。连接管理／准备不上传矩阵，确认后才发送到摘要中的实际目的地。本地默认、文件表示与数学规则仍由原Core维护，业务门面不另写转换。

`ordinarySetupResult(normalizeSetupResult(raw))`提供安全配置的同源普通投影：saved／available／simulation／unknown、configured、远端尚未核实及下一步；保留`configureApiKeyAsync`的私密输入流程，不接收对话秘密。原技术配置结果仍可用于审计。

接口能约束普通参数、持久计划和返回内容，不能控制任意Host最终措辞，也不能验证不可伪造的人类授权。技术profile与旧显式接口保留兼容能力，不属于权限隔离边界。

## 同一模型的本机产物

Core导出`GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION=isingq-guided-model-artifacts-v1`。可选`model_markdown`是Agent编写的业务说明，完整保存并绑定本次QUBO；工具不据此认证业务语义等价。Core复用WorkspaceArtifacts，在私有目录固定轮次的本请求output目录创建model.md、qubo.json、matrix.csv，拒绝覆盖及不安全路径。数学表达、变量映射、normalized QUBO与CSV来自同一输入；小模型完整展开，大模型用精确求和式与映射概述，完整系数和映射在文件，不把大矩阵内联到对话。

同一计划choose/status/refresh复用文件，不重复导出。确认前及最终异步目标准备后核对文件字节与输入绑定；改动／缺失／损坏会阻断并撤销旧确认版本，恢复后仍需新的明确确认，不覆盖、自动修复或自动提交。已受理历史仍按原记录读取。

业务建模由宿主Agent完成，业务对话是否联网由宿主决定；QUBO校验／准备／产物处理在Toolkit运行主机进行。文件入口仅代表该主机上的实际本机文件；当前范围为本地stdio，不为远程客户端承诺可点即开，也没有新增下载服务。

完整模型正文展示前核对当前文件字节；不一致、缺失或不安全时不返回缓存正文冒充文件，未提交计划转阻断并撤销旧确认。已受理任务仍读取原输入和原状态，文件问题单独标注。纯进度的files_only不重复大文件哈希，status/integrity为not_checked并明确未重新核对；已发现的失配仍如实unavailable。只建模计划在文件核对、故障和恢复中保持纯本机处理，只有用户显式选择prepare才进入目标阶段。文件链接使用合法Markdown目标编码，实际files[].path保持真实绝对路径。

就绪主操作固定为确认提交、查看／更换目标、管理本地连接、暂不提交四项；具体目标只在选择阶段列出。refresh底层能力保留，但不作为每次就绪菜单项；管理后提供“配置完成，继续检查”的现成回调，实际阻断时可重新检查。明确要求求解准备时直接prepare（同时导出并准备目标），model仅用于纯建模／导出，不是前置强制轮次。

新导出的自动QUBO数学段使用独立LaTeX `$$…$$` 和 `aligned`，数值、符号及多位下标由已验证QUBO机械生成；科学计数使用乘以10的幂，不把字母e当变量。小模型分行完整表达，大模型用精确求和式及完整文件。`modeling.math_format`仅标记自动QUBO段：新导出为latex，旧manifest无标记为legacy_text；不迁移或覆盖旧文件。Agent的model_markdown原文保留，公式由生产者使用行内或独立LaTeX数学块，不由程序猜改任意文本。

## 候选结果的业务收尾

`GUIDED_RESULT_REVIEW_CONTRACT_VERSION=isingq-guided-result-review-v1`。普通 MCP 仍是四个工具，增加的是同一 `isingq_solve` 中的只读 `review` 动作；整个工具仍含提交、管理等动作，不能将整体标成只读。

1. 正常求解返回 `candidate_ready` 时提供“核对并解读本次结果”现成 call。Host 继续原求解链，不停在位串／任务成功处，也不再问用户是否允许解读。
2. Host 沿用原建模上下文，只在该 call 中补充 `review` 业务信息。`model`、`data` 复用既有 math-model-v1；可选 `baseline` 是同模型参考方案。变量直接使用原位 ID `x_0`、`x_1` 等，或提供原编码 `bindings`。不修改原控制关联，不把 QUBO 罚项目标当作业务目标。
3. 程序只读取一次原任务快照，从该记录的位串构造本次赋值；不接收候选替换、自报目标或核验结论。先用共享 QUBO 函数核对位串及原 QUBO 值，再调用 `buildVerifiedReport` 复算原业务模型的目标、变量域、逐条约束与可比基线。
4. `result_reviewed` 表示本次复核操作完成，业务结果另看 `review.status=feasible|infeasible`；原任务的技术状态和结果文件不改写。回复直接给业务变量、目标值、逐项复核、参考方案比较及明确范围。Host 再基于这些已核对事实解释业务含义，不新增未核实数字、硬件或收益结论。

业务输入示例（仅示范结构，实际数值和约束须逐项沿用原模型）：

```json
{
  "model": {
    "schema_version": "math-model-v1",
    "id": "original-business",
    "variables": [{"id":"x_0","domain":"binary","label":"原决策含义"}],
    "objective": {"sense":"max","expression":{"terms":[{"coefficient":3,"variables":["x_0"]}]}},
    "constraints": [{"id":"limit","expression":{"terms":[{"coefficient":1,"variables":["x_0"]}]},"relation":"le","rhs":1}]
  },
  "data": {},
  "baseline": {"x_0":0}
}
```

整数／补码／取反等编码必须用原映射显式表示。`bindings` 为业务变量 ID 到 math-model-v1 表达式的对象，例如 `q=x_0+2*x_1`：`{"q":{"terms":[{"coefficient":1,"variables":["x_0"]},{"coefficient":2,"variables":["x_1"]}]}}`。映射系数使用整数常量；引用必须落在原位串范围。解码表达式也由既有精确整数计算器执行，不执行任意代码。

解码先代入原记录中已知的0/1位，再交给同一精确整数求值器；这些原位不占用业务变量配额。每项引用1到2个原位，纯常量使用 `constant`，不使用空引用项。代入保留项的顺序和零项，非法系数即便会乘到0也拒绝，中间溢出也拒绝，不只检查最终总值。

没有原业务核验信息时返回 `needs_review_model`，仍提供已核对的位串解码和 QUBO 值，业务目标与可行性保持未知。原业务信息由 Host 整理；真有业务缺项时只询问缺项，不要求用户提供 JSON、字段名或内部协议。不从模型说明自由文本解析出权威约束，也不默认为无约束。

数学核验保持有限整数、目标至多二次、约束仿射与安全整数运算。业务变量、约束、模型总项及映射总项不再沿用原型的256／1024／20000数量上限；完整原模型按实际规模核验，也不以设备位数推算约束数。统一使用 `isingq-verification-capacity-v1` 输入容量保护，普通review对完整model/data/baseline/bindings合计计算紧凑UTF-8 JSON字节，默认按4095满二次模型加余量计算为1 GiB，运行设置为 `ISINGQ_MAX_VERIFICATION_INPUT_BYTES`（十进制整数字节）。同源Core模型及报告入口也对各自完整核验输入作聚合检查；不复用求解记录或矩阵文件的容量设置。核验容量属于宿主后台信息，不在正常业务答复中展开。容量超限、配置无效、映射越界或算术溢出时为 `review_blocked`，不截断、缩放、改模、重算或把失败当可行；维护者调整核验进程容量后可重试同一保存候选。所有历史／再次核对均只消费原记录，不读云 Key，不访问设备或账单；历史列表不批量自动复核。

普通review复用 `buildVerifiedReport(document,{render:false})` 的同一份候选核验事实、摘要及数值比较，不构建随后会被丢弃的完整报告Markdown；独立报告入口默认仍完整渲染。聊天表格仍最多40行，完整变量域与全部约束先核验并保留结构数据，失败项优先展示；4095位机型不意味着只取256个业务变量。

输入模型及映射仍由 Host 负责表达原业务语义；数值核验不自动证明自然语言完整性、QUBO 等价或全局最优。普通回复由同一次核验事实生成，完整技术报告能力继续由既有报告 API 提供；本动作不新增结果网页或强制文件交付。

较大模型通过Core的 `writeMathModelReviewFile` 生成清单与分块数据，model/prepare附带 `review_file` 后，确认／状态／候选复核沿同一原请求自动携带引用。review_file与内联review互斥；复核仅消费保存候选，不允许文件自报候选或核验结论。文件方式会写新的完整核验明细，原任务、模型和结果不写回。当前默认依据及云端规则责任边界见 [文件分块核验](../packages/core/REVIEW-FILE.md)。
