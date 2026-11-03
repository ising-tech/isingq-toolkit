# QUBO 契约与完整模型摘要规范

本规范对应 `QUBO_CONTRACT_VERSION = '1'` 和 `MODEL_DIGEST_VERSION = 'isingq-model-v1'`。实现唯一位于 `src/qubo.js`，根入口与 `/qubo` 子路径导出同一实现。修改摘要字节规则必须使用新的 MODEL_DIGEST_VERSION；破坏现有校验、归一化或计算行为时必须使用新的 QUBO_CONTRACT_VERSION。增加兼容的输出字段不改变现有版本。

## 输入与现有归一化

模型顶层只允许五个字段：

| 字段 | 规则 |
| --- | --- |
| `num_bits` | 必填，1 至 2048 的整数 |
| `linear` | 可选数组，每项为 `{ index, coefficient }` |
| `quadratic` | 可选数组，每项为 `{ i, j, coefficient }`；禁止 i=j，统一为 i<j |
| `offset` | 可选有限 number；省略、undefined、null 都按 0 处理 |
| `variables` | 可选数组，每项为 `{ index, name, meaning? }` |

三个数组省略或为 undefined 时按空数组处理，显式 null、字符串、对象、布尔值或数字都报错。每个条目必须是非 null 的 object，不能是数组。索引为 `[0, num_bits)` 整数；系数只能为有限 number，不能传数字字符串、null、NaN 或 Infinity。重复 linear 索引、重复 quadratic 变量对（含相反方向）、重复 variables 索引均报错，零系数也不能绕过重复检查。

name 必须是 trim 后非空的 string，原始长度不得超过 200 个 JavaScript UTF-16 code units；规范化后保留 trim 结果。meaning 省略或为 null 时归一为 null，否则按 `String(value).trim()` 处理，包括数字、布尔值等现有可转换类型。空字符串 meaning 与 null 不等价。条目中现有实现未读取的额外字段不参与归一化或摘要；顶层额外字段始终报错。此版本没有新增更严格的嵌套字段规则。

`validateQubo` 返回的 qubo 保持原有 linear/quadratic 输入次序（quadratic 方向归一），variables 按 index 升序；显式零系数保留，summary 的 term 计数也保留。摘要计算只使用独立视图，不能重排或删除返回 qubo 中的项。

## model_sha256 的字节定义

1. 先运行相同的 `validateQubo` 输入校验和归一化；非法模型不产生摘要。
2. 构造以下固定字段顺序的 object，不能依赖原始输入 object 的键顺序：

   ```text
   {
     model_digest_version: "isingq-model-v1",
     num_bits: <integer>,
     offset: <number>,
     linear: [{index, coefficient}, ...],
     quadratic: [{i, j, coefficient}, ...],
     variables: [{index, name, meaning}, ...]
   }
   ```

3. linear 删除 coefficient 为 0 或 -0 的项，按 index 数值升序。每项的键顺序为 index、coefficient。
4. quadratic 删除 coefficient 为 0 或 -0 的项，先按 i 再按 j 数值升序。每项的键顺序为 i、j、coefficient，且 i<j。
5. variables 使用全部显式提供且归一化后的映射，按 index 数值升序。每项的键顺序为 index、name、meaning。不自动补 x_i 名称；缺失映射与显式 `{ index: i, name: "x_i" }` 不等价。名称和含义不做 Unicode NFC/NFD 归一化。
6. 以 JavaScript `JSON.stringify` 的精确语义序列化（无缩进、无额外空格、无 BOM、无末尾换行）。数值按 ECMAScript JSON number 表示，-0 输出为 0；不舍入小数，1 与 1.0 等价。字符串按 JSON.stringify 规则转义，包括 lone surrogate。跨语言实现必须复现这些字节，而非使用其默认 JSON 输出格式。
7. 对该字符串的 UTF-8 字节计算 SHA-256，输出 64 字符小写十六进制 model_sha256，并返回 model_digest_version。

因此，项顺序、quadratic 方向、显式零系数、offset 的 null/undefined/省略/0/-0 及既有 trim 归一化不会改变模型摘要；num_bits、非零系数、offset 数值、变量索引/名称/含义变化会改变它。摘要表达此处定义的完整模型身份，不尝试判断任意代数模型是否等价，也不包含 solver_options 或自然语言业务描述。

### 黄金样例

空二变量模型 `{ "num_bits": 2 }` 的完整摘要字节为以下单行（代码块本身的换行不参与摘要）：

```json
{"model_digest_version":"isingq-model-v1","num_bits":2,"offset":0,"linear":[],"quadratic":[],"variables":[]}
```

model_sha256：`dc13b4fa895f29bd84117f9eb57b5e12460aaa1d8856a320b6ef7250a949dc71`。

包含系数、小数、offset 和中文变量映射的完整字节：

```json
{"model_digest_version":"isingq-model-v1","num_bits":3,"offset":1.25,"linear":[{"index":0,"coefficient":-2},{"index":2,"coefficient":0.5}],"quadratic":[{"i":0,"j":2,"coefficient":3}],"variables":[{"index":0,"name":"选择 A","meaning":"主变量"},{"index":2,"name":"b","meaning":null}]}
```

model_sha256：`904814071ad3cf94447b7abe88990e9b9389c2a241ae666b31f2351dd4575b73`。

## 输出、矩阵与幂等边界

`modelDigest(input)` 返回 `{ model_sha256, model_digest_version }`。`validateQubo(input).summary`、`matrixDocument(input).summary` 和 `SolverService.validate(input)` 同样包含这两个字段。MCP 的 `isingq_qubo_validate` 在响应 `structuredContent.data` 中直接返回同一 service 结果；文本 content 中的 JSON 与其一致。上述计算完全本地执行。

matrixDocument 的 `sha256` 和 service 的 `matrix_sha256` 继续只对原有 upper-triangular CSV 字节计算摘要：num_bits 行、每行 num_bits 个逗号分隔数字、每行末尾 LF。offset 和 variables 不写入 CSV；20 MiB 上限仍在 matrixDocument 检查。modelDigest 和 validateQubo 本身不分配矩阵，也不保证模型生成的 CSV 通过大小检查。

完整模型摘要不能替换矩阵摘要或既有 request_digest：

- 矩阵摘要用于核对实际上传矩阵。
- 完整模型摘要用于跨消费方核对含 offset 和变量映射的模型，必须连同 model_digest_version 比较。
- 既有 request_digest 仍对原有顺序的 `{ qubo: normalizedQubo, solver_options }` 的 JSON.stringify 结果计算 SHA-256，继续控制提交幂等。摘要相同不意味着旧 request_digest 一定相同，消费方不得据此放宽同 key 校验。

此能力不新增工具、网络请求或云端字段，也不更改上传、求解参数、幂等键和本地求解记录格式。
