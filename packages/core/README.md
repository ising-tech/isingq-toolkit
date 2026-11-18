# @ising-tech/isingq-core

面向集成开发者的 Node.js SDK，提供 QUBO 建模指导、校验、矩阵导出、目标值计算和变量解码，以及云端／内网本地求解器接入能力。MCP、DSH 和专家 CLI 复用本包。

简体中文 · [English](README.en.md)

Agent 用户可直接使用 [MCP](https://www.npmjs.com/package/@ising-tech/isingq-mcp) 或 [DSH Plugin](https://www.npmjs.com/package/@ising-tech/isingq-dsh-plugin)。

## 安装

需要 Node.js **18.17+**。本文适用于 **0.9.x**，安装以 npm 实际发布为准。

```bash
npm install @ising-tech/isingq-core
```

## 最小示例

使用 CommonJS 在本地校验 QUBO，并计算给定位串的目标值，无需网络或 API Key：

```js
const { validateQubo, objectiveEnergy } = require('@ising-tech/isingq-core');
const { qubo, summary } = validateQubo({
  num_bits: 2,
  linear: [{ index: 0, coefficient: -1 }],
});
console.log(summary.num_bits);            // 2
console.log(objectiveEnergy(qubo, [1, 0])); // -1
```

## 常用 API

| API | 用途 |
| --- | --- |
| `modelingGuide(problemSummary)` | 获取 QUBO 建模步骤与约束处理指导 |
| `validateQubo(input)` | 校验并规范化 QUBO，返回模型与摘要 |
| `matrixDocument(input)` | 生成 CSV 矩阵内容及矩阵摘要 |
| `modelDigest(input)` | 生成包含系数、常数项与变量映射的完整模型摘要 |
| `objectiveEnergy(qubo, bits)` | 计算给定位串的 QUBO 目标值，包含常数项 |
| `decodeBits(qubo, bits)` | 按变量映射解码位串 |
| `SolverService` | 管理本地连接和求解目标，提供准备、提交与任务查询 |

业务模型构造与用户确认由调用方负责。云端提交需要个人 API Key 和明确的付款选择；本地求解不要求云端 API Key。

## 详细文档

[API 与数据约定](API.md) · [完整模型摘要规范](MODEL-DIGEST.md) · [求解目标接入](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/solver-targets.md) · [统一求解流程](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/guided-solve.md) · [Apache-2.0](LICENSE)
