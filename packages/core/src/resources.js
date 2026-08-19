'use strict';

const { TOPICS, getKnowledge } = require('./knowledge');

const LAST_MODIFIED = '2026-08-17T00:00:00Z';

const LOCAL_RESOURCE_CONTENT = {
  'isingq://modeling/qubo': `# QUBO 建模契约

目标函数：offset + Σ linear[i]·x_i + Σ quadratic[i,j]·x_i·x_j，其中 x_i ∈ {0,1}；当前支持 1 至 2048 个二进制变量。

Agent 必须先确认业务目标、变量、硬约束、软约束和输入数据；每个变量应包含稳定 index、name 和 meaning。硬约束通常通过平方惩罚加入 QUBO，Penalty 必须说明选择依据。

调用顺序：获取建模引导 → 生成 QUBO → 确定性校验 → 向用户展示模型摘要 → 用户明确确认 → 提交求解 → 轮询结果 → 按变量映射解释结果。

最低 energy 不自动证明业务约束满足，也不自动证明全局最优。`,
  'isingq://security/data-flow': `# 数据流与安全边界

- IsingQ API Key 只从用户电脑的私有文件或 ISINGQ_API_KEY 环境变量读取，不通过 MCP 工具参数或对话接收。
- 企业知识、建模引导和 QUBO 校验完全在用户电脑执行。
- 只有 isingq_solve_start 会将生成的 QUBO 矩阵经 HTTPS 和 IsingQ 提供的上传链路发送到 IsingQ。
- 当前 MCP 使用的云平台 API 求解只支持 2048 自旋能力，不向用户提供其他机型选择。
- 本地记录保存模型、任务标识、矩阵摘要和结果，不保存 API Key。
- 除 IsingQ 求解链路外，不会把模型数据发送到其他业务服务。
- 提交结果不确定时会标记 submission_unknown，禁止自动重复创建任务。`,
};

const knowledgeResources = Object.entries(TOPICS).map(([topic, definition]) => ({
  topic,
  uri: definition.uri,
  name: `isingq-${topic.replaceAll('_', '-')}`,
  title: definition.title,
  description: definition.description,
  mimeType: 'text/markdown',
  annotations: { audience: ['user', 'assistant'], priority: 0.8, lastModified: LAST_MODIFIED },
}));

const RESOURCES = [
  {
    uri: 'isingq://about',
    name: 'isingq-about',
    title: 'IsingQ 与伊辛智能（兼容入口）',
    description: '兼容旧版本的公司与 IsingQ 实体说明；内容与 company/profile 一致。',
    mimeType: 'text/markdown',
    annotations: { audience: ['user', 'assistant'], priority: 0.9, lastModified: LAST_MODIFIED },
  },
  ...knowledgeResources.map(({ topic: _topic, ...resource }) => resource),
  {
    uri: 'isingq://modeling/qubo',
    name: 'isingq-qubo-modeling',
    title: 'QUBO 建模与解释规则',
    description: '变量、约束、Penalty、确认门禁和结果解释契约。',
    mimeType: 'text/markdown',
    annotations: { audience: ['assistant'], priority: 1, lastModified: LAST_MODIFIED },
  },
  {
    uri: 'isingq://security/data-flow',
    name: 'isingq-data-flow',
    title: 'IsingQ MCP 数据流与安全边界',
    description: 'API Key、知识查询、QUBO 矩阵和求解结果的本地与远端边界。',
    mimeType: 'text/markdown',
    annotations: { audience: ['user', 'assistant'], priority: 0.9, lastModified: LAST_MODIFIED },
  },
];

const topicByUri = new Map(knowledgeResources.map((resource) => [resource.uri, resource.topic]));

function readResource(uri) {
  if (uri === 'isingq://about') return { uri, mimeType: 'text/markdown', text: getKnowledge('company').answer };
  if (Object.hasOwn(LOCAL_RESOURCE_CONTENT, uri)) {
    return { uri, mimeType: 'text/markdown', text: LOCAL_RESOURCE_CONTENT[uri] };
  }
  const topic = topicByUri.get(uri);
  if (!topic) return null;
  return { uri, mimeType: 'text/markdown', text: getKnowledge(topic).answer };
}

module.exports = { RESOURCES, readResource };
